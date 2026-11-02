import { randomUUID } from "node:crypto";
import {
  MAIL_IMPORT_DESTINATION_CHANGED,
  type MailImportInput,
  type MailImportSnapshot,
  type MailImportTools,
} from "@opensuite/contracts";
import {
  createMailImportStore,
  createSecretBox,
  type PrismaClient,
  type SecretBox,
} from "@opensuite/db";
import { z } from "zod";
import type { Actor } from "./accounts.ts";
import { createJmapAccess, fail } from "./jmap-access.ts";

type Store = ReturnType<typeof createMailImportStore>;
type Job = NonNullable<Awaited<ReturnType<Store["get"]>>>;

type Options = Parameters<typeof createJmapAccess>[0] & {
  db: PrismaClient;
  key: string;
  tools: MailImportTools<
    Connection["client"],
    Connection["session"],
    Job,
    Buffer
  >;
};
type Connection = Awaited<
  ReturnType<ReturnType<typeof createJmapAccess>["connect"]>
>;
type ImportWork = {
  job: Job;
  token: string;
  actor: Actor;
  connection: Connection;
  mapping: Record<string, string>;
  archive: Buffer;
  snapshot: MailImportSnapshot | undefined;
  snapshotError: string;
};

class MigrationService {
  private readonly options: Options;
  private readonly tools: Options["tools"];
  private readonly store: Store;
  private readonly box: SecretBox;
  private readonly access: ReturnType<typeof createJmapAccess>;
  constructor(options: Options) {
    this.options = options;
    this.tools = options.tools;
    this.store = createMailImportStore(options.db);
    const secret = createSecretBox(options.key);
    if (secret.isErr()) throw new Error("Invalid mail import key");
    this.box = secret.value;
    this.access = createJmapAccess(options);
  }
  private open(actor: Actor, accountId: string) {
    return this.access.connect(actor, accountId, "urn:ietf:params:jmap:mail");
  }
  private async ownerAccount(actor: Actor, accountId: string) {
    const store = this.options.store;
    const credential = await store.getForOwner(actor.id, accountId);
    if (credential.isErr()) return fail("forbidden");
    if (accountId !== "default" && credential.value.accountId !== accountId)
      return fail("forbidden");
    return credential.value.accountId;
  }
  private async owned(actor: Actor, accountId: string, id: string) {
    const account = await this.ownerAccount(actor, accountId);
    return (await this.store.get(actor.id, account, id)) ?? fail("not_found");
  }
  private async destinationNames(
    connection: Connection,
    mailboxId: string,
    labels: Record<string, string>,
  ) {
    if (Object.keys(labels).length > 100) return fail("validation");
    const result = await this.tools.captureMigrationDestinations({
      client: connection.client,
      session: connection.session,
      accountId: connection.id,
      ids: [mailboxId, ...Object.values(labels)],
    });
    if (result.kind === "retry") return fail("unavailable");
    if (result.kind === "changed") return fail("validation");
    return result.names;
  }
  private async createJob(actor: Actor, input: MailImportInput) {
    const raw = Buffer.from(input.base64, "base64");
    const total = await this.tools
      .countArchive(
        raw,
        input.format,
        input.variant,
        Object.keys(input.labels).length,
      )
      .catch(() => fail("validation"));
    const accountId = await this.ownerAccount(actor, input.accountId);
    const connection = await this.open(actor, accountId);
    if (connection.id !== accountId) return fail("forbidden");
    const mailboxNames = await this.destinationNames(
      connection,
      input.mailboxId,
      input.labels,
    );
    const id = randomUUID();
    const encrypted = this.box.encrypt(`v1:${raw.toString("base64")}`, {
      userId: actor.id,
      id,
    });
    if (encrypted.isErr()) return fail("unavailable");
    try {
      await this.store.create({
        id,
        userId: actor.id,
        accountId,
        format: input.format,
        variant: input.variant,
        mailboxId: input.mailboxId,
        labels: input.labels,
        mailboxNames,
        archive: encrypted.value,
        total,
      });
    } catch (cause) {
      if (z.object({ code: z.literal("P2002") }).safeParse(cause).success)
        return fail("conflict");
      return fail("unavailable");
    }
    return this.tools.migrationReport(await this.owned(actor, accountId, id));
  }
  create(actor: Actor, input: MailImportInput) {
    return this.access.run(() => this.createJob(actor, input));
  }
  list(actor: Actor, accountId: string) {
    return this.access.run(async () => {
      const account = await this.ownerAccount(actor, accountId);
      return { jobs: await this.store.list(actor.id, account) };
    });
  }
  report(actor: Actor, accountId: string, id: string) {
    return this.access.run(async () =>
      this.tools.migrationReport(await this.owned(actor, accountId, id)),
    );
  }
  cancel(actor: Actor, accountId: string, id: string) {
    return this.access.run(async () => {
      const current = await this.owned(actor, accountId, id);
      await this.store.cancel(actor.id, current.accountId, id);
      const updated = await this.owned(actor, current.accountId, id);
      return this.tools.migrationReport(updated);
    });
  }
  resume(actor: Actor, accountId: string, id: string) {
    return this.access.run(async () => {
      const current = await this.owned(actor, accountId, id);
      if (current.error === MAIL_IMPORT_DESTINATION_CHANGED)
        return fail("conflict");
      if (!(await this.store.resume(actor.id, current.accountId, id)).count)
        return fail("conflict");
      const updated = await this.owned(actor, current.accountId, id);
      return this.tools.migrationReport(updated);
    });
  }
  remap(
    actor: Actor,
    accountId: string,
    id: string,
    mailboxId: string,
    labels: Record<string, string>,
  ) {
    return this.access.run(async () => {
      const current = await this.owned(actor, accountId, id);
      const connection = await this.open(actor, current.accountId);
      if (connection.id !== current.accountId) return fail("forbidden");
      const mailboxNames = await this.destinationNames(
        connection,
        mailboxId,
        labels,
      );
      const changed = await this.store.remap({
        userId: actor.id,
        accountId: current.accountId,
        id,
        mailboxId,
        labels,
        mailboxNames,
      });
      if (!changed.count) return fail("conflict");
      return this.tools.migrationReport(
        await this.owned(actor, current.accountId, id),
      );
    });
  }
  abandon(
    actor: Actor,
    accountId: string,
    id: string,
    confirm: boolean,
    uncertainCount: number,
  ) {
    return this.access.run(async () => {
      if (!confirm) return fail("validation");
      const current = await this.owned(actor, accountId, id);
      if (
        !(await this.store.abandon(
          actor.id,
          current.accountId,
          id,
          uncertainCount,
        ))
      )
        return fail("conflict");
      return { abandoned: true as const };
    });
  }
  private async prepareSnapshot(
    job: Job,
    token: string,
    actor: Actor,
    connection: Connection,
    archive: Buffer,
    mapping: Record<string, string>,
  ) {
    if (
      job.cancelRequested ||
      !job.items.some((item) => item.status === "pending")
    )
      return undefined;
    return this.tools.prepareMigrationSnapshot({
      client: connection.client,
      session: connection.session,
      accountId: connection.id,
      archive,
      format: job.format,
      variant: job.variant,
      ids: [job.mailboxId, ...Object.values(mapping)],
      expected: job.mailboxNames,
      keepAlive: async () => {
        await this.ownerAccount(actor, job.accountId);
        return this.store.beforeMapping(job.id, token, new Date());
      },
    });
  }
  private async shouldProcess(
    job: Job,
    token: string,
    actor: Actor,
    item: Job["items"][number],
  ) {
    const current = await this.store.get(job.userId, job.accountId, job.id);
    if (current === null || current.claimToken !== token)
      return fail("conflict");
    await this.ownerAccount(actor, job.accountId);
    return (
      !current.cancelRequested ||
      ["importing", "uncertain"].includes(item.status)
    );
  }
  private async processArchive(work: ImportWork) {
    const {
      job,
      token,
      actor,
      connection,
      mapping,
      archive,
      snapshot,
      snapshotError,
    } = work;
    let index = 0;
    let envelope: Buffer | undefined;
    for await (const raw of this.tools.archiveMessages(
      archive,
      job.format,
      job.variant,
      (line) => {
        envelope = line;
      },
    )) {
      const item = job.items[index++];
      if (item === undefined) return fail("unavailable");
      if (!(await this.shouldProcess(job, token, actor, item))) continue;
      const outcome = await this.tools.runMigrationItem({
        client: connection.client,
        session: connection.session,
        accountId: connection.id,
        raw,
        envelope,
        status: item.status,
        marker: item.marker,
        mapping,
        destination: job.mailboxId,
        snapshot,
        snapshotError,
        metadata: (...args) => this.tools.messageMetadata(...args),
        mailboxPatch: (mailboxes) => this.tools.mailboxPatch(mailboxes),
        importMessage: (input) => this.tools.importMigrationMessage(input),
        record: (status, error, id) =>
          this.store.item(job.id, token, item.index, status, error, id),
        beforeImport: () =>
          this.store.beforeImport(job.id, token, item.index, new Date()),
        keepAlive: async () => {
          await this.ownerAccount(actor, job.accountId);
          return this.store.beforeMapping(job.id, token, new Date());
        },
        expected: job.mailboxNames,
        onChanged: () =>
          this.store.finish(
            job.id,
            token,
            "attention",
            MAIL_IMPORT_DESTINATION_CHANGED,
            false,
          ),
      });
      if (outcome !== "continue")
        return outcome === "defer" ? ("defer" as const) : undefined;
    }
    return undefined;
  }
  private async process(job: Job, token: string) {
    if (job.archive === null) return fail("unavailable");
    const decrypted = this.box.decrypt(job.archive, {
      userId: job.userId,
      id: job.id,
    });
    if (decrypted.isErr()) return fail("unavailable");
    if (!decrypted.value.startsWith("v1:")) return fail("unavailable");
    const actor: Actor = { id: job.userId, email: "", role: "user" };
    const connection = await this.open(actor, job.accountId);
    if (connection.id !== job.accountId) return fail("forbidden");
    const mapping = z.record(z.string(), z.string()).parse(job.labels);
    const archive = Buffer.from(decrypted.value.slice(3), "base64");
    const prepared = await this.prepareSnapshot(
      job,
      token,
      actor,
      connection,
      archive,
      mapping,
    );
    const snapshot = prepared?.kind === "ready" ? prepared.snapshot : undefined;
    if (prepared?.kind === "failed" && prepared.error === "destination") {
      await this.store.finish(
        job.id,
        token,
        "attention",
        MAIL_IMPORT_DESTINATION_CHANGED,
        false,
      );
      return undefined;
    }
    if (prepared?.kind === "failed" && prepared.error === "unavailable")
      return "defer" as const;
    const snapshotError = "Destination exceeds the duplicate scan limit";
    return this.processArchive({
      job,
      token,
      actor,
      connection,
      mapping,
      archive,
      snapshot,
      snapshotError,
    });
  }
  async work() {
    const claimed = await this.store.claim(new Date());
    if (claimed === null) return false;
    const { job, token } = claimed;
    try {
      let deferred = false;
      if (
        !job.cancelRequested ||
        job.items.some((item) =>
          ["importing", "uncertain"].includes(item.status),
        )
      ) {
        const result = await this.access.run(() => this.process(job, token));
        if (result.isErr())
          return await this.store.defer(job.id, token, result.error.kind);
        deferred = result.value === "defer";
      }
      await this.store.settle(job, token, deferred);
    } catch {
      await this.store.finish(
        job.id,
        token,
        "attention",
        "Import worker unavailable",
        false,
      );
    }
    return true;
  }
}
export const createMailMigrationService = (options: Options) =>
  new MigrationService(options);
export type MailMigrationService = MigrationService;
