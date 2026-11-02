import { randomUUID } from "node:crypto";
import type {
  MailImportInput,
  MailImportInspection,
  MailImportInspectionFailure,
  MailImportMetadata,
  MailImportSnapshot,
  MailImportTools,
} from "@opensuite/contracts";
import {
  createMailImportStore,
  createSecretBox,
  type PrismaClient,
  type SecretBox,
} from "@opensuite/db";
import { z } from "zod";
import type { Result } from "neverthrow";
import type { Actor } from "./accounts.ts";
import { createJmapAccess, fail, value } from "./jmap-access.ts";

type Store = ReturnType<typeof createMailImportStore>;
type Job = NonNullable<Awaited<ReturnType<Store["get"]>>>;

type Options = Parameters<typeof createJmapAccess>[0] & {
  db: PrismaClient;
  key: string;
  tools: MailImportTools<
    Connection["client"],
    Connection["session"],
    Job,
    InspectionResult,
    Buffer
  >;
};
type Connection = Awaited<
  ReturnType<ReturnType<typeof createJmapAccess>["connect"]>
>;
type InspectionResult = Result<
  MailImportInspection,
  MailImportInspectionFailure
>;

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
    const boxes = value(
      await connection.client.mailboxes(connection.session, connection.id),
    ).list;
    const valid = new Set(boxes.map((item) => item.id));
    if (
      ![input.mailboxId, ...Object.values(input.labels)].every((id) =>
        valid.has(id),
      )
    )
      return fail("validation");
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
      if (!(await this.store.resume(actor.id, current.accountId, id)).count)
        return fail("conflict");
      const updated = await this.owned(actor, current.accountId, id);
      return this.tools.migrationReport(updated);
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
  private async import(
    job: Job,
    token: string,
    item: Job["items"][number],
    raw: Buffer,
    meta: MailImportMetadata,
    connection: Connection,
    snapshot: MailImportSnapshot,
  ) {
    const result = await this.tools.importMigrationMessage({
      client: connection.client,
      session: connection.session,
      accountId: connection.id,
      bytes: raw,
      metadata: meta,
      marker: item.marker,
      snapshot,
      beforeImport: () =>
        this.store.beforeImport(job.id, token, item.index, new Date()),
      onImported: (id) =>
        this.store.item(job.id, token, item.index, "imported", null, id),
    });
    if (result.kind !== "recorded")
      await this.store.item(
        job.id,
        token,
        item.index,
        result.kind,
        result.error,
        null,
      );
    return result.proceed;
  }
  private async processItem(
    job: Job,
    token: string,
    item: Job["items"][number],
    raw: Buffer,
    mapping: Record<string, string>,
    connection: Connection,
    envelope: Buffer | undefined,
    snapshot: MailImportSnapshot | undefined,
    snapshotError: string,
  ) {
    if (["imported", "duplicate", "failed"].includes(item.status)) return true;
    let meta: MailImportMetadata;
    try {
      meta = await this.tools.messageMetadata(
        raw,
        mapping,
        job.mailboxId,
        envelope,
      );
    } catch {
      await this.store.item(
        job.id,
        token,
        item.index,
        item.status === "pending" ? "failed" : "uncertain",
        "Message metadata could not be parsed",
        null,
      );
      return true;
    }
    if (item.status === "pending" && snapshot === undefined) {
      await this.store.item(
        job.id,
        token,
        item.index,
        "failed",
        snapshotError,
        null,
      );
      return true;
    }
    const decision = await this.tools.resolveMigrationCandidate({
      client: connection.client,
      session: connection.session,
      accountId: connection.id,
      bytes: raw,
      messageId: meta.messageId,
      ...(item.status === "pending" ? {} : { marker: item.marker }),
      ...(item.status === "pending" && snapshot !== undefined
        ? { snapshot }
        : {}),
      mailboxPatch: this.tools.mailboxPatch(meta.mailboxIds),
      beforeMapping: () => this.store.beforeMapping(job.id, token, new Date()),
    });
    if ("status" in decision)
      await this.store.item(
        job.id,
        token,
        item.index,
        decision.status,
        decision.error,
        decision.id,
      );
    if (decision.action === "stop") return false;
    if (decision.action === "continue") return true;
    if (snapshot === undefined) return false;
    return this.import(job, token, item, raw, meta, connection, snapshot);
  }
  private async prepareSnapshot(
    job: Job,
    token: string,
    actor: Actor,
    connection: Connection,
    archive: Buffer,
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
    );
    const snapshot = prepared?.kind === "ready" ? prepared.snapshot : undefined;
    const snapshotError =
      prepared?.kind === "failed" && prepared.error === "limit"
        ? "Destination exceeds the duplicate scan limit"
        : "Destination changed or duplicate scan failed";
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
      if (
        !(await this.processItem(
          job,
          token,
          item,
          raw,
          mapping,
          connection,
          envelope,
          snapshot,
          snapshotError,
        ))
      )
        break;
    }
    return undefined;
  }
  async work() {
    const claimed = await this.store.claim(new Date());
    if (claimed === null) return false;
    const { job, token } = claimed;
    try {
      if (
        !job.cancelRequested ||
        job.items.some((item) =>
          ["importing", "uncertain"].includes(item.status),
        )
      ) {
        const result = await this.access.run(() => this.process(job, token));
        if (result.isErr()) throw new Error("Import worker unavailable");
      }
      await this.store.settle(job, token);
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
export function createMailMigrationService(options: Options) {
  return new MigrationService(options);
}
export type MailMigrationService = ReturnType<
  typeof createMailMigrationService
>;
