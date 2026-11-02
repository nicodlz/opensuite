import { randomUUID } from "node:crypto";
import {
  DIRECT_ABANDON_WARNING,
  DirectMigrationReportSchema,
  MAIL_IMPORT_DESTINATION_CHANGED,
  migrationReport,
  type DirectMigrationInput,
} from "@opensuite/contracts";
import {
  createDirectImportStore,
  createSecretBox,
  type SecretBox,
} from "@opensuite/db";
import { z } from "zod";
import type { Actor } from "./accounts.ts";
import { createJmapAccess, fail } from "./jmap-access.ts";
import {
  DirectDetails as Details,
  DirectWorker,
  directSecret,
  type DirectJob as Job,
  type DirectOptions as Options,
  type DirectStore as Store,
} from "./migration-direct-worker.ts";

const limitations = [
  "Only explicitly mapped source labels or folders are assigned to destination mailboxes; unmapped labels and unsupported flags are not preserved.",
  "At most 100 folders and 1,000 messages per job; individual messages are limited to 4 MiB.",
  "Source changes or missing messages require attention. IMAP servers without Gmail message identifiers may expose the same message in multiple folders.",
  "Messages without a reliable Message-ID cannot be deduplicated; collisions and unknown import outcomes require attention.",
  "For a duplicate already in the destination, existing flags and dates are not replaced by source values.",
  "Duplicate checks are bounded and do not establish global uniqueness. Source credentials expire after 24 hours.",
];
function resumable(job: Job) {
  return (
    job.status === "attention" &&
    !job.cancelRequested &&
    job.claimToken === null &&
    job.error !== MAIL_IMPORT_DESTINATION_CHANGED
  );
}
function needsCredential(job: Job) {
  const unavailable =
    !job.sourceConfig ||
    !job.sourceExpiresAt ||
    job.sourceExpiresAt <= new Date();
  return (
    unavailable &&
    (!job.inventoryReady ||
      job.items.some((item) => ["pending", "failed"].includes(item.status)))
  );
}
function validateResumeCredential(
  job: Job,
  password: string | undefined,
  oauthEnabled: boolean | undefined,
) {
  if (Details.parse(job.sourceDetails).authKind !== "oauth") return;
  if (!oauthEnabled) fail("validation");
  if (password !== undefined && job.sourceConfig !== null) fail("conflict");
}
function report(job: Job) {
  const base = migrationReport(job);
  const uncertainCount = job.items.filter((item) =>
    ["importing", "uncertain"].includes(item.status),
  ).length;
  return DirectMigrationReportSchema.parse({
    ...base,
    source: job.sourceKind,
    inventoryReady: job.inventoryReady,
    limitations,
    recovery:
      job.status === "attention" &&
      !job.cancelRequested &&
      job.error === MAIL_IMPORT_DESTINATION_CHANGED
        ? {
            action: "cancel",
            message:
              "The destination changed; cancel this job and start a new one after reviewing the destination.",
          }
        : job.status === "attention" && !job.cancelRequested
          ? {
              action: "resume",
              message:
                job.error ??
                "Review failed messages and resume; a new source password may be required.",
            }
          : null,
    abandonment:
      job.status === "attention" &&
      job.claimToken === null &&
      job.sourceConfig === null &&
      uncertainCount > 0
        ? { uncertainCount, warning: DIRECT_ABANDON_WARNING }
        : null,
  });
}

export class DirectMigrationService {
  private readonly store: Store;
  private readonly access: ReturnType<typeof createJmapAccess>;
  private readonly box: SecretBox;
  private readonly options: Options;
  private readonly worker: DirectWorker;
  constructor(options: Options) {
    this.options = options;
    this.store = createDirectImportStore(options.db);
    this.access = createJmapAccess(options);
    const box = createSecretBox(options.key);
    if (box.isErr()) throw new Error("Invalid migration key");
    this.box = box.value;
    const runtime = {
      options,
      store: this.store,
      box: this.box,
      access: this.access,
      account: (actor: Actor, accountId: string) =>
        this.account(actor, accountId),
      secret: (job: Job) => directSecret(runtime, job),
    };
    this.worker = new DirectWorker(runtime);
  }
  private async account(actor: Actor, accountId: string) {
    const credential = await this.options.store.getForOwner(
      actor.id,
      accountId,
    );
    if (
      credential.isErr() ||
      (accountId !== "default" && credential.value.accountId !== accountId)
    )
      return fail("forbidden");
    return credential.value.accountId;
  }
  private async owned(actor: Actor, accountId: string, id: string) {
    const account = await this.account(actor, accountId);
    return (await this.store.get(actor.id, account, id)) ?? fail("not_found");
  }
  create(actor: Actor, input: DirectMigrationInput) {
    return this.access.run(async () => {
      if (Object.keys(input.labels).length > 100) return fail("validation");
      const accountId = await this.account(actor, input.accountId);
      const destination = await this.access.connect(
        actor,
        accountId,
        "urn:ietf:params:jmap:mail",
      );
      if (destination.id !== accountId) return fail("forbidden");
      const names = await this.options.tools.captureMigrationDestinations({
        client: destination.client,
        session: destination.session,
        accountId,
        ids: [input.mailboxId, ...Object.values(input.labels)],
      });
      if (names.kind === "retry") return fail("unavailable");
      if (names.kind === "changed") return fail("validation");
      const id = randomUUID();
      const source =
        input.source.kind === "gmail"
          ? {
              kind: "gmail" as const,
              username: input.source.username,
              host: "imap.gmail.com",
              port: 993,
              authKind: input.source.oauthAccessToken
                ? ("oauth" as const)
                : ("password" as const),
              password: input.source.oauthAccessToken ?? input.source.password,
            }
          : { ...input.source, authKind: "password" as const };
      if (source.authKind === "oauth" && !this.options.oauthEnabled)
        return fail("validation");
      const { password, ...details } = source;
      const encrypted = this.box.encrypt(password, { userId: actor.id, id });
      if (encrypted.isErr()) return fail("unavailable");
      try {
        await this.store.create({
          id,
          userId: actor.id,
          accountId,
          mailboxId: input.mailboxId,
          labels: input.labels,
          mailboxNames: names.names,
          sourceKind: source.kind,
          sourceDetails: details,
          sourceConfig: encrypted.value,
          sourceExpiresAt: new Date(Date.now() + 24 * 3600_000),
        });
      } catch (cause) {
        if (z.object({ code: z.literal("P2002") }).safeParse(cause).success)
          return fail("conflict");
        return fail("unavailable");
      }
      return report(await this.owned(actor, accountId, id));
    });
  }
  list(actor: Actor, accountId: string) {
    return this.access.run(async () => {
      const id = await this.account(actor, accountId);
      return {
        jobs: (await this.store.list(actor.id, id)).map((job) => ({
          id: job.id,
          source: z.enum(["gmail", "imap"]).parse(job.sourceKind),
          status: DirectMigrationReportSchema.shape.status.parse(job.status),
          createdAt: job.createdAt.toISOString(),
        })),
      };
    });
  }
  report(actor: Actor, accountId: string, id: string) {
    return this.access.run(async () =>
      report(await this.owned(actor, accountId, id)),
    );
  }
  cancel(actor: Actor, accountId: string, id: string) {
    return this.access.run(async () => {
      const job = await this.owned(actor, accountId, id);
      await this.store.cancel(
        actor.id,
        job.accountId,
        id,
        Details.parse(job.sourceDetails).authKind === "password",
      );
      return report(await this.owned(actor, job.accountId, id));
    });
  }
  resume(actor: Actor, accountId: string, id: string, password?: string) {
    return this.access.run(async () => {
      const job = await this.owned(actor, accountId, id);
      if (!resumable(job)) return fail("conflict");
      validateResumeCredential(job, password, this.options.oauthEnabled);
      const encrypted =
        password === undefined
          ? undefined
          : this.box.encrypt(password, { userId: actor.id, id });
      if (encrypted?.isErr()) return fail("unavailable");
      if (!encrypted && needsCredential(job)) return fail("validation");
      if (
        !(await this.store.resume(
          actor.id,
          job.accountId,
          id,
          encrypted && encrypted.isOk() ? encrypted.value : undefined,
        ))
      )
        return fail("conflict");
      return report(await this.owned(actor, job.accountId, id));
    });
  }
  revoke(actor: Actor, accountId: string, id: string) {
    return this.access.run(async () => {
      const job = await this.owned(actor, accountId, id);
      if (
        !this.options.oauthEnabled ||
        Details.parse(job.sourceDetails).authKind !== "oauth" ||
        job.status !== "attention" ||
        job.claimToken !== null ||
        !job.sourceConfig
      )
        return fail("conflict");
      const token = this.box.decrypt(job.sourceConfig, {
        userId: actor.id,
        id,
      });
      if (token.isErr()) return fail("unavailable");
      if (!(await this.options.revokeOAuth?.(token.value)))
        return fail("unavailable");
      if (
        !(await this.store.clearCredential(
          actor.id,
          job.accountId,
          id,
          job.sourceConfig,
        ))
      )
        return fail("conflict");
      return { revoked: true as const };
    });
  }
  abandon(actor: Actor, accountId: string, id: string, uncertainCount: number) {
    return this.access.run(async () => {
      const job = await this.owned(actor, accountId, id);
      if (
        !(await this.store.abandon(actor.id, job.accountId, id, uncertainCount))
      )
        return fail("conflict");
      return { abandoned: true as const };
    });
  }
  work() {
    return this.worker.work();
  }
}
export const createDirectMigrationService = (options: Options) =>
  new DirectMigrationService(options);
