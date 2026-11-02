import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  ScheduledSchema,
  scheduledDto,
  type ScheduleDelivery,
} from "@opensuite/contracts";
import {
  createScheduledSendStore,
  type DraftGuardBegin,
  type PrismaClient,
  type ScheduledRecord,
  type ScheduledSendStore,
} from "@opensuite/db";
import {
  delayedSendTiming,
  matchesSubmission,
  type JmapClient,
  type Session,
} from "@opensuite/jmap";

type MailConnection = {
  client: JmapClient;
  session: Session;
  id: string;
  owner: string;
};
const KnownError = z.object({
  kind: z.enum([
    "not_found",
    "forbidden",
    "validation",
    "conflict",
    "rate_limited",
  ]),
});

async function guardDraft<T>(
  store: ScheduledSendStore,
  c: MailConnection,
  ids: string[],
  work: (beginWrite: DraftGuardBegin) => Promise<T>,
  conflict: () => never,
): Promise<T> {
  const token = randomUUID();
  const acquired: string[] = [];
  let completed = false;
  const state = { writing: false };
  try {
    await [...new Set(ids)].toSorted().reduce<Promise<void>>(
      (previous, id) =>
        previous.then(async () => {
          if (!(await store.acquire(c.owner, c.id, id, token)))
            return conflict();
          acquired.push(id);
          return undefined;
        }),
      Promise.resolve(),
    );
    const result = await work(async (phase, mutationState) => {
      await store.beginWrite(
        c.owner,
        c.id,
        acquired,
        token,
        phase,
        mutationState,
      );
      state.writing = true;
      return acquired.length ? token : undefined;
    });
    completed = true;
    return result;
  } catch (error) {
    if (!state.writing || KnownError.safeParse(error).success) completed = true;
    throw error;
  } finally {
    if (completed || acquired.length < new Set(ids).size)
      await Promise.all(
        acquired.map((id) => store.release(c.owner, c.id, id, token)),
      );
  }
}

async function reconcileSubmission(
  c: MailConnection,
  row: ScheduledRecord,
  store: ScheduledSendStore,
) {
  let id = row.submissionId;
  if (!id) {
    const query = await c.client.scheduled.submissionIds(
      c.session,
      c.id,
      row.draftId,
    );
    if (
      query.isErr() ||
      query.value.total === undefined ||
      query.value.total !== query.value.ids.length
    )
      return undefined;
    const candidates = query.value.ids.filter(
      (item) => !row.previousIds.includes(item),
    );
    if (candidates.length !== 1) {
      await store.transition(row.id, ["creating"], "unknown");
      return undefined;
    }
    id = candidates[0] ?? null;
    if (!id) return undefined;
  }
  const result = await c.client.scheduled.submissions(c.session, c.id, [id]);
  if (result.isErr() || result.value.list.length !== 1) return undefined;
  const submission = result.value.list[0];
  if (!submission || !matchesSubmission(submission, row)) return undefined;
  if (row.state === "canceling" && submission.undoStatus === "pending") {
    const canceled = await c.client.scheduled.cancelSubmission(
      c.session,
      c.id,
      submission.id,
    );
    if (canceled.isOk())
      return { ...submission, undoStatus: "canceled" as const };
  }
  return submission;
}

function delaySeconds(
  c: MailConnection,
  delivery: ScheduleDelivery,
  now: number,
  reject: (kind: "validation" | "unavailable") => never,
) {
  return delayedSendTiming(
    { session: c.session, accountId: c.id, delivery, now },
    reject,
  );
}
async function submit(
  c: MailConnection,
  store: ScheduledSendStore,
  p: {
    requestId: string;
    draftId: string;
    threadId: string;
    identityId: string;
    from: string;
    recipients: { email: string }[];
    seconds: number;
  },
  now: number,
) {
  const {
    requestId,
    draftId,
    threadId,
    identityId,
    from,
    recipients,
    seconds,
  } = p;
  const fallback = ScheduledSchema.parse({
    id: requestId,
    draftId,
    threadId,
    releaseAt: new Date(now + seconds * 1000).toISOString(),
    state: "unknown",
  });
  try {
    const sent = await c.client.scheduled.scheduleSubmission(
      c.session,
      c.id,
      draftId,
      identityId,
      { mailFrom: { email: from }, rcptTo: recipients },
      seconds,
      requestId,
    );
    if (sent.isOk())
      await store.transition(
        requestId,
        ["creating"],
        sent.value.undoStatus === "pending" ? "pending" : "unknown",
        { submissionId: sent.value.id, releaseAt: new Date(sent.value.sendAt) },
      );
    else if (
      sent.error.kind === "set" ||
      sent.error.kind === "method" ||
      (sent.error.kind === "network" && sent.error.beforeRequest)
    ) {
      const row = await store.get(c.owner, requestId);
      if (row) await store.finish(row, ["creating", "unknown"], "failed");
    } else await store.transition(requestId, ["creating"], "unknown");
    const row = await store.get(c.owner, requestId);
    return row ? scheduledDto(row) : fallback;
  } catch {
    return fallback;
  }
}
async function reserve(
  store: ScheduledSendStore,
  input: Omit<ScheduledRecord, "submissionId" | "createdAt">,
  verify: () => Promise<string[]>,
  conflict: () => never,
) {
  if (!(await store.reserve(input))) return conflict();
  try {
    const previousIds = await verify();
    if (
      !(await store.transition(input.id, ["preparing"], "creating", {
        previousIds,
      }))
    )
      return conflict();
  } catch (error) {
    const row = await store.get(input.userId, input.id);
    if (row) await store.finish(row, ["preparing"], "failed");
    throw error;
  }
  return undefined;
}
async function recoverSentGuard(
  c: MailConnection,
  store: ScheduledSendStore,
  guard: Awaited<ReturnType<ScheduledSendStore["staleGuards"]>>[number],
  before: Date,
) {
  const ids = await c.client.scheduled.submissionIds(
    c.session,
    c.id,
    guard.draftId,
  );
  if (
    ids.isErr() ||
    ids.value.total === undefined ||
    ids.value.total !== ids.value.ids.length
  )
    throw new Error("submission lookup incomplete");
  const result = await c.client.scheduled.submissions(
    c.session,
    c.id,
    ids.value.ids,
  );
  if (result.isErr() || result.value.notFound.length)
    throw new Error("submission lookup incomplete");
  const matches = result.value.list.filter(
    (item) => item.envelope.mailFrom.parameters?.["ENVID"] === guard.token,
  );
  const match = matches[0];
  if (matches.length !== 1 || !match || match.undoStatus === "pending")
    throw new Error("submission outcome unknown");
  const canceled = match.undoStatus === "canceled";
  const mailboxes = await c.client.mailboxes(c.session, c.id);
  if (mailboxes.isErr()) throw new Error("mailboxes unavailable");
  const box = mailboxes.value.list.find(
    (item) => item.role === (canceled ? "drafts" : "sent"),
  );
  if (!box) throw new Error("mailbox unavailable");
  const updated = await c.client.updateEmail(c.session, c.id, guard.draftId, {
    mailboxIds: { [box.id]: true },
    "keywords/$draft": canceled ? true : null,
    "keywords/$seen": true,
  });
  if (
    updated.isErr() &&
    !(updated.error.kind === "set" && updated.error.type === "notFound")
  )
    throw new Error("draft reconciliation incomplete");
  await store.clearStaleGuard(guard, before);
}
async function recoverMutationGuard(
  c: MailConnection,
  store: ScheduledSendStore,
  guard: Awaited<ReturnType<ScheduledSendStore["staleGuards"]>>[number],
  before: Date,
) {
  if (
    !guard.mutationState ||
    !(await c.client.fenceDraftMutation({
      session: c.session,
      accountId: c.id,
      draftId: guard.draftId,
      token: guard.token,
      state: guard.mutationState,
    }))
  )
    throw new Error("draft mutation unresolved");
  await store.clearStaleGuard(guard, before);
}
async function sweep(
  store: ScheduledSendStore,
  connect: (
    actor: { id: string; email: string; role: "user" },
    accountId: string,
  ) => Promise<MailConnection>,
  now: () => number,
  visit: (row: ScheduledRecord) => Promise<void>,
) {
  const before = new Date(now() - 300_000);
  const guards = await store.staleGuards(before);
  const failedGuards = await guards.reduce<Promise<boolean>>(
    (previous, guard) =>
      previous.then(async (failed) => {
        try {
          if (guard.phase === "preparing")
            await store.clearStaleGuard(guard, before);
          else {
            const c = await connect(
              { id: guard.userId, email: "", role: "user" },
              "default",
            );
            if (c.id !== guard.accountId) throw new Error("mailbox changed");
            if (guard.phase === "send")
              await recoverSentGuard(c, store, guard, before);
            else if (guard.phase === "mutation")
              await recoverMutationGuard(c, store, guard, before);
            else {
              const result = await c.client.destroyEmail(
                c.session,
                c.id,
                guard.draftId,
              );
              if (
                result.isOk() ||
                (result.error.kind === "set" &&
                  result.error.type === "notFound")
              )
                await store.clearStaleGuard(guard, before);
              else throw new Error("draft deletion unresolved");
            }
          }
          return failed;
        } catch {
          await store.touchGuard(guard, new Date(now()));
          return true;
        }
      }),
    Promise.resolve(false),
  );
  const page = async (after?: string): Promise<boolean> => {
    const rows = await store.work(after, new Date(now()));
    const failed = await rows.reduce<Promise<boolean>>(
      (previous, row) =>
        previous.then(async (previouslyFailed) => {
          try {
            await visit(row);
            return previouslyFailed;
          } catch {
            return true;
          }
        }),
      Promise.resolve(false),
    );
    const last = rows.at(-1);
    return rows.length === 100 && last
      ? (await page(last.id)) || failed
      : failed;
  };
  if ((await page()) || failedGuards)
    throw new Error("scheduled reconciliation incomplete");
}
export function createGuards(db: PrismaClient) {
  const store = createScheduledSendStore(db);
  return {
    scheduledStore: store,
    guardDraft: <T>(
      c: MailConnection,
      ids: string[],
      work: (beginWrite: DraftGuardBegin) => Promise<T>,
      conflict: () => never,
    ) => guardDraft(store, c, ids, work, conflict),
    reconcileSubmission,
    delaySeconds,
    submit,
    reserve,
    sweep,
  };
}
export function start(
  service: { reconcileScheduled(): Promise<void> },
  onError: () => void,
  intervalMs = 5_000,
) {
  let running: Promise<void> | undefined;
  const tick = () => {
    if (running) return;
    running = service
      .reconcileScheduled()
      .catch(onError)
      .finally(() => {
        running = undefined;
      });
  };
  tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  return async () => {
    clearInterval(timer);
    await running;
  };
}
