import {
  DIRECT_SOURCE_LIMIT,
  DirectSourceRefSchema,
  MAIL_IMPORT_DESTINATION_CHANGED,
  type DirectConnection,
  type DirectSourceRef,
  type MailImportMetadata,
  type MailImportSnapshot,
} from "@opensuite/contracts";
import { z } from "zod";
import type { Actor } from "./accounts.ts";
import { fail } from "./jmap-access.ts";
import type {
  DirectJob,
  DirectRuntime,
  DirectTarget,
} from "./migration-direct-worker.ts";

type Item = DirectJob["items"][number];
type Outcome = "continue" | "defer" | "stop";
const uncertain = (status: string) =>
  ["importing", "uncertain"].includes(status);
function messageFlags(ref: DirectSourceRef) {
  const keywords: Record<string, boolean> = {};
  for (const [flag, keyword] of [
    ["\\Seen", "$seen"],
    ["\\Flagged", "$flagged"],
    ["\\Answered", "$answered"],
    ["\\Draft", "$draft"],
  ] as const)
    if (ref.flags.includes(flag)) keywords[keyword] = true;
  return keywords;
}
function mappedMailboxes(
  ref: DirectSourceRef,
  job: DirectJob,
  mapping: Record<string, string>,
) {
  return Object.fromEntries([
    [job.mailboxId, true],
    ...ref.labels
      .filter((label) => Object.hasOwn(mapping, label))
      .flatMap((label) => {
        const id = mapping[label];
        return id === undefined ? [] : [[id, true] as const];
      }),
  ]);
}

export class DirectProcessor {
  private source: DirectConnection | undefined;
  private readonly actor: Actor;
  private readonly runtime: DirectRuntime;
  private job: DirectJob;
  private readonly token: string;
  constructor(runtime: DirectRuntime, job: DirectJob, token: string) {
    this.runtime = runtime;
    this.job = job;
    this.token = token;
    this.actor = { id: job.userId, email: "", role: "user" };
  }
  private async connectSource() {
    return (this.source ??= await this.runtime.options.connectSource(
      this.runtime.secret(this.job),
    ));
  }
  private keepAlive = async () => {
    if (!this.job.sourceExpiresAt || this.job.sourceExpiresAt <= new Date())
      return false;
    await this.runtime.account(this.actor, this.job.accountId);
    return this.runtime.store.shared.beforeMapping(
      this.job.id,
      this.token,
      new Date(),
    );
  };
  private async inventory() {
    if (this.job.inventoryReady || this.job.cancelRequested) return "ready";
    if (!(await this.keepAlive())) return "defer";
    let refs: DirectSourceRef[];
    try {
      refs = await (await this.connectSource()).inventory();
    } catch (cause) {
      if (
        z.object({ code: z.literal(DIRECT_SOURCE_LIMIT) }).safeParse(cause)
          .success
      )
        return "limit";
      throw cause;
    }
    if (!(await this.runtime.store.inventory(this.job.id, this.token, refs)))
      return "defer";
    this.job =
      (await this.runtime.store.get(
        this.job.userId,
        this.job.accountId,
        this.job.id,
      )) ?? fail("not_found");
    return "ready";
  }
  private async raw(item: Item, ref: DirectSourceRef) {
    const { box, store } = this.runtime;
    const context = {
      userId: this.job.userId,
      id: `${this.job.id}:${String(item.index)}`,
    };
    if (item.sourceRaw) {
      const value = box.decrypt(item.sourceRaw, context);
      if (value.isErr()) return fail("unavailable");
      return {
        kind: "ready" as const,
        bytes: Buffer.from(value.value, "base64"),
      };
    }
    if (item.status !== "pending") return fail("conflict");
    let raw: Buffer;
    try {
      raw = Buffer.from(await (await this.connectSource()).read(ref));
    } catch {
      await store.item(
        this.job.id,
        this.token,
        item.index,
        "failed",
        "Source message unavailable or changed",
        null,
      );
      return { kind: "failed" as const };
    }
    const encrypted = box.encrypt(raw.toString("base64"), context);
    if (
      encrypted.isErr() ||
      !(await store.raw(this.job.id, this.token, item.index, encrypted.value))
    )
      return { kind: "stop" as const };
    return { kind: "ready" as const, bytes: raw };
  }
  private async metadata(
    raw: Buffer,
    ref: DirectSourceRef,
  ): Promise<MailImportMetadata> {
    const parsed = await this.runtime.options.tools.messageMetadata(
      raw,
      {},
      this.job.mailboxId,
    );
    const mapping = z.record(z.string(), z.string()).parse(this.job.labels);
    return {
      ...parsed,
      messageId:
        parsed.messageId && /^[^\s<>@]+@[^\s<>@]+$/.test(parsed.messageId)
          ? parsed.messageId
          : null,
      mailboxIds: mappedMailboxes(ref, this.job, mapping),
      keywords: messageFlags(ref),
      ...(ref.date ? { receivedAt: ref.date.replace(/\.\d{3}Z$/, "Z") } : {}),
    };
  }
  private async snapshot(
    target: DirectTarget,
    item: Item,
    metadata: MailImportMetadata,
  ) {
    if (item.status !== "pending")
      return { kind: "ready" as const, snapshot: undefined };
    if (!(await this.keepAlive())) return { kind: "stop" as const };
    const result = await this.runtime.options.tools.createSnapshot({
      client: target.client,
      session: target.session,
      accountId: target.id,
      messageIds: metadata.messageId ? [metadata.messageId] : [],
      keepAlive: this.keepAlive,
    });
    if (result.isErr()) {
      await this.runtime.store.item(
        this.job.id,
        this.token,
        item.index,
        "failed",
        "Duplicate scan unavailable or exceeded limit",
        null,
      );
      return { kind: "failed" as const };
    }
    return { kind: "ready" as const, snapshot: result.value };
  }
  private invoke(
    target: DirectTarget,
    item: Item,
    raw: Buffer,
    metadata: MailImportMetadata,
    snapshot: MailImportSnapshot | undefined,
  ) {
    const {
      store,
      options: { tools },
    } = this.runtime;
    const job = this.job;
    const token = this.token;
    const mapping = z.record(z.string(), z.string()).parse(job.labels);
    return tools.runMigrationItem({
      client: target.client,
      session: target.session,
      accountId: target.id,
      raw,
      status: item.status,
      marker: item.marker,
      mapping,
      destination: job.mailboxId,
      snapshot,
      snapshotError: "Duplicate scan unavailable",
      metadata: () => Promise.resolve(metadata),
      mailboxPatch: (mailboxes) => tools.mailboxPatch(mailboxes),
      importMessage: (input) => tools.importMigrationMessage(input),
      record: (status, error, id) =>
        store.item(job.id, token, item.index, status, error, id),
      beforeImport: () =>
        store.shared.beforeImport(job.id, token, item.index, new Date()),
      keepAlive: this.keepAlive,
      expected: job.mailboxNames,
      onChanged: () =>
        store.shared.finish(
          job.id,
          token,
          "attention",
          MAIL_IMPORT_DESTINATION_CHANGED,
          false,
        ),
    });
  }
  private async processItem(
    target: DirectTarget,
    item: Item,
  ): Promise<Outcome> {
    if (["imported", "duplicate", "failed"].includes(item.status))
      return "continue";
    const current = await this.runtime.store.get(
      this.job.userId,
      this.job.accountId,
      this.job.id,
    );
    if (!current || current.claimToken !== this.token) return "stop";
    if (current.cancelRequested && item.status === "pending") return "continue";
    const ref = DirectSourceRefSchema.parse(item.sourceRef);
    const source = await this.raw(item, ref);
    if (source.kind === "stop") return "stop";
    if (source.kind === "failed") return "continue";
    const raw = source.bytes;
    const metadata = await this.metadata(raw, ref);
    const prepared = await this.snapshot(target, item, metadata);
    if (prepared.kind === "stop") return "stop";
    if (prepared.kind === "failed") return "continue";
    const outcome = await this.invoke(
      target,
      item,
      raw,
      metadata,
      prepared.snapshot,
    );
    if (outcome !== "continue") return "defer";
    if (!uncertain(item.status)) return "continue";
    const after = await this.runtime.store.get(
      this.job.userId,
      this.job.accountId,
      this.job.id,
    );
    return after?.items.some(
      (entry) => entry.index === item.index && uncertain(entry.status),
    )
      ? "stop"
      : "continue";
  }
  private async processItems(
    target: DirectTarget,
    items: Item[],
    index = 0,
  ): Promise<"defer" | undefined> {
    const item = items[index];
    if (!item) return undefined;
    const outcome = await this.processItem(target, item);
    if (outcome === "defer") return "defer";
    if (outcome === "stop") return undefined;
    return this.processItems(target, items, index + 1);
  }
  async run() {
    const target = await this.runtime.access.connect(
      this.actor,
      this.job.accountId,
      "urn:ietf:params:jmap:mail",
    );
    if (target.id !== this.job.accountId) return fail("forbidden");
    const restore = this.runtime.options.tools.stableEmailChanges(
      target.client,
    );
    try {
      const inventory = await this.inventory();
      if (inventory === "limit") return "limit";
      if (inventory === "defer") return undefined;
      const items = this.job.items.toSorted(
        (a, b) => Number(!uncertain(a.status)) - Number(!uncertain(b.status)),
      );
      return await this.processItems(target, items);
    } finally {
      restore();
      this.source?.close();
    }
  }
}
