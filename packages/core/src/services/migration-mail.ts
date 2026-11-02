import { randomUUID } from "node:crypto";
import type {
  MailImportInput,
  MailImportInspection,
  MailImportInspectionFailure,
  MailImportMetadata,
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
    const credential = await this.options.store.getForOwner(
      actor.id,
      accountId,
    );
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
      return this.tools.migrationReport(
        await this.owned(actor, current.accountId, id),
      );
    });
  }
  resume(actor: Actor, accountId: string, id: string) {
    return this.access.run(async () => {
      const current = await this.owned(actor, accountId, id);
      if (!(await this.store.resume(actor.id, current.accountId, id)).count)
        return fail("conflict");
      return this.tools.migrationReport(
        await this.owned(actor, current.accountId, id),
      );
    });
  }
  private async duplicate(
    job: Job,
    token: string,
    item: Job["items"][number],
    meta: MailImportMetadata,
    connection: Connection,
    id: string,
  ) {
    if (item.status !== "pending") {
      await this.store.item(job.id, token, item.index, "imported", null, id);
      return;
    }
    if (!(await this.store.beforeMapping(job.id, token, new Date()))) return;
    const updated = await connection.client.updateEmail(
      connection.session,
      connection.id,
      id,
      this.tools.mailboxPatch(meta.mailboxIds),
    );
    await this.store.item(
      job.id,
      token,
      item.index,
      updated.isErr() ? "failed" : "duplicate",
      updated.isErr() ? "Duplicate mailbox mapping failed" : null,
      id,
    );
  }
  private async inspect(
    job: Job,
    token: string,
    item: Job["items"][number],
    raw: Buffer,
    meta: MailImportMetadata,
    connection: Connection,
  ) {
    const inspection = await this.tools.inspectMigrationCandidates({
      client: connection.client,
      session: connection.session,
      accountId: connection.id,
      bytes: raw,
      messageId: meta.messageId,
      ...(item.status === "pending" ? {} : { marker: item.marker }),
    });
    if (
      inspection.isErr() ||
      inspection.value.kind === "collision" ||
      (item.status !== "pending" && inspection.value.kind !== "match")
    ) {
      await this.store.item(
        job.id,
        token,
        item.index,
        item.status === "pending" ? "failed" : "uncertain",
        "Import outcome or duplicate could not be established",
        null,
      );
      return false;
    }
    if (inspection.value.kind === "match") {
      await this.duplicate(
        job,
        token,
        item,
        meta,
        connection,
        inspection.value.id,
      );
      return false;
    }
    return true;
  }
  private async import(
    job: Job,
    token: string,
    item: Job["items"][number],
    raw: Buffer,
    meta: MailImportMetadata,
    connection: Connection,
  ) {
    const uploaded = await connection.client.upload(
      connection.session,
      connection.id,
      raw,
    );
    if (uploaded.isErr()) {
      await this.store.item(
        job.id,
        token,
        item.index,
        "failed",
        "Upload failed",
        null,
      );
      return true;
    }
    if (!(await this.store.beforeImport(job.id, token, item.index, new Date())))
      return false;
    const imported = await connection.client.importEmail(
      connection.session,
      connection.id,
      {
        blobId: uploaded.value.blobId,
        mailboxIds: meta.mailboxIds,
        keywords: { ...meta.keywords, [item.marker]: true },
        ...(meta.receivedAt === undefined
          ? {}
          : { receivedAt: meta.receivedAt }),
      },
    );
    if (imported.isOk()) {
      await this.store.item(
        job.id,
        token,
        item.index,
        "imported",
        null,
        imported.value.id,
      );
      return true;
    }
    const certain =
      imported.error.kind === "set" ||
      (imported.error.kind === "network" &&
        imported.error.beforeRequest === true);
    await this.store.item(
      job.id,
      token,
      item.index,
      certain ? "failed" : "uncertain",
      certain ? "Message import rejected" : "Import outcome uncertain",
      null,
    );
    return true;
  }
  private async processItem(
    job: Job,
    token: string,
    item: Job["items"][number],
    raw: Buffer,
    mapping: Record<string, string>,
    connection: Connection,
    envelope: Buffer | undefined,
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
        "failed",
        "Message metadata could not be parsed",
        null,
      );
      return true;
    }
    if (!(await this.inspect(job, token, item, raw, meta, connection)))
      return true;
    return this.import(job, token, item, raw, meta, connection);
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
    let index = 0;
    let envelope: Buffer | undefined;
    for await (const raw of this.tools.archiveMessages(
      Buffer.from(decrypted.value.slice(3), "base64"),
      job.format,
      job.variant,
      (line) => {
        envelope = line;
      },
    )) {
      const item = job.items[index++];
      if (item === undefined) return fail("unavailable");
      const current = await this.store.get(job.userId, job.accountId, job.id);
      if (current === null || current.claimToken !== token)
        return fail("conflict");
      await this.ownerAccount(actor, job.accountId);
      if (
        current.cancelRequested &&
        !["importing", "uncertain"].includes(item.status)
      )
        continue;
      if (
        !(await this.processItem(
          job,
          token,
          item,
          raw,
          mapping,
          connection,
          envelope,
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
