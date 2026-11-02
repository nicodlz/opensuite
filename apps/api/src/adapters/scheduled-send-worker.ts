import { randomUUID } from "node:crypto";
import type { Mailbox } from "@opensuite/contracts";
import type { JmapClient, Session } from "@opensuite/jmap";
import type {
  ScheduledFailure,
  ScheduledRecord,
  ScheduledSendStore,
} from "@opensuite/db";
import type { ReleaseAuthorization } from "./scheduled-send-authorization.ts";

type Connection = {
  client: JmapClient;
  session: Session;
  id: string;
  owner: string;
  address: string;
};
type EmailResult = Awaited<ReturnType<JmapClient["emails"]>>;
type Email = Extract<EmailResult, { value: unknown }>["value"]["list"][number];
type WorkerContext = {
  now(): number;
  store: ScheduledSendStore;
  connect(
    actor: { id: string; email: string; role: "user" },
    accountId: string,
  ): Promise<Connection>;
  boxes(c: Connection): Promise<Mailbox[]>;
  draft(c: Connection, id: string): Promise<Email>;
  sender(
    c: Connection,
    email: Email,
    forRelease?: boolean,
  ): Promise<{
    from: string;
    identityId: string;
    recipients: { email: string }[];
  }>;
  reconcileSubmission(
    c: Connection,
    row: ScheduledRecord,
    store: ScheduledSendStore,
  ): Promise<
    | {
        id: string;
        sendAt: string;
        undoStatus: "pending" | "final" | "canceled";
      }
    | undefined
  >;
};
const isFailure = (error: unknown, kind: string) =>
  typeof error === "object" &&
  error !== null &&
  "kind" in error &&
  error.kind === kind;

async function release(
  c: Connection,
  row: ScheduledRecord,
  ctx: WorkerContext,
) {
  const sent = (await ctx.boxes(c)).find((box) => box.role === "sent")?.id;
  if (!sent) throw new Error("sent mailbox unavailable");
  const updated = await c.client.updateEmail(c.session, c.id, row.draftId, {
    mailboxIds: { [sent]: true },
    "keywords/$draft": null,
    "keywords/$seen": true,
  });
  if (updated.isOk()) await ctx.store.finish(row, ["releasing"], "sent");
}

async function reconcile(row: ScheduledRecord, ctx: WorkerContext) {
  const c = await ctx.connect(
    { id: row.userId, email: "", role: "user" },
    row.accountId,
  );
  if (row.state === "releasing") return release(c, row, ctx);
  const found = await ctx.reconcileSubmission(c, row, ctx.store);
  if (!found) {
    await ctx.store.transition(row.id, ["creating"], "unknown");
    return;
  }
  if (found.undoStatus === "canceled") {
    await ctx.store.finish(
      row,
      ["creating", "unknown", "canceling"],
      "canceled",
    );
  } else if (found.undoStatus === "final") {
    if (
      await ctx.store.transition(
        row.id,
        ["creating", "unknown", "canceling"],
        "releasing",
        { submissionId: found.id },
      )
    )
      await release(c, row, ctx);
  } else {
    // A provider-held or otherwise unresolved item is never presented as canceled.
    await ctx.store.transition(row.id, ["creating", "canceling"], "unknown", {
      submissionId: found.id,
    });
  }
}

async function submit(
  row: ScheduledRecord,
  ctx: WorkerContext,
  c: Connection,
  sender: Awaited<ReturnType<WorkerContext["sender"]>>,
) {
  try {
    const result = await c.client.submit(
      c.session,
      c.id,
      row.draftId,
      row.identityId,
      { mailFrom: { email: sender.from }, rcptTo: sender.recipients },
      undefined,
      { requestId: row.id },
    );
    if (result.isOk()) {
      if (
        await ctx.store.transition(row.id, ["creating"], "releasing", {
          submissionId: result.value.id,
        })
      )
        await release(c, row, ctx);
    } else if (
      result.error.kind === "set" ||
      result.error.kind === "method" ||
      (result.error.kind === "network" && result.error.beforeRequest)
    ) {
      await ctx.store.fail(row, "submission_rejected");
    } else await ctx.store.transition(row.id, ["creating"], "unknown");
  } catch {
    // Once the handoff starts, neither a crash nor a lost response is safe to retry.
    await ctx.store.transition(row.id, ["creating"], "unknown");
  }
}

async function hasIdentity(c: Connection, row: ScheduledRecord) {
  const result = await c.client.identities(c.session, c.id);
  if (result.isErr()) throw new Error("identities unavailable");
  return result.value.list.some(
    (identity) =>
      identity.id === row.identityId &&
      identity.email.toLowerCase() === row.senderAddress,
  );
}

async function previousSubmissionIds(c: Connection, draftId: string) {
  const result = await c.client.scheduled.submissionIds(
    c.session,
    c.id,
    draftId,
  );
  if (result.isErr()) throw new Error("submission lookup unavailable");
  const { ids, total } = result.value;
  if (total === undefined || total !== ids.length)
    throw new Error("submission lookup incomplete");
  return ids;
}

async function prepare(
  row: ScheduledRecord,
  ctx: WorkerContext,
  authorize: ReleaseAuthorization,
  token: string,
) {
  const reject = async (reason: ScheduledFailure) => {
    await ctx.store.fail(row, reason, token);
  };
  const first = await authorize(row);
  if (first) return reject(first);
  const c = await ctx.connect(
    { id: row.userId, email: "", role: "user" },
    row.accountId,
  );
  let email;
  try {
    email = await ctx.draft(c, row.draftId);
  } catch (error) {
    if (isFailure(error, "not_found")) return reject("draft_unavailable");
    throw error;
  }
  const from = email.from?.[0]?.email.toLowerCase() ?? c.address.toLowerCase();
  if (from !== row.senderAddress) return reject("sender_unavailable");
  if (!(await hasIdentity(c, row))) return reject("sender_unavailable");
  const sender = await ctx.sender(c, email, true);
  if (sender.from !== row.senderAddress || sender.identityId !== row.identityId)
    return reject("sender_unavailable");
  const previous = await previousSubmissionIds(c, row.draftId);
  // Re-read mutable authorization after all provider reads, immediately before
  // committing the handoff. Unknown authorization defers, never submits.
  const final = await authorize(row);
  if (final) return reject(final);
  if (
    await ctx.store.beginSubmission(
      row.id,
      token,
      new Date(ctx.now()),
      previous,
    )
  )
    await submit(row, ctx, c, sender);
}

export function createScheduledWorker(authorize: ReleaseAuthorization) {
  return async (row: ScheduledRecord, ctx: WorkerContext) => {
    if (!["pending", "preparing"].includes(row.state))
      return reconcile(row, ctx);
    const token = randomUUID();
    if (!(await ctx.store.claim(row.id, new Date(ctx.now()), token))) return;
    try {
      await prepare(row, ctx, authorize, token);
    } catch (error) {
      await ctx.store.defer(row.id, token);
      throw error;
    }
  };
}
