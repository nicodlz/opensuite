import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  ScheduledSchema,
  scheduledDto,
  type ScheduleDelivery,
} from "@opensuite/contracts";
import {
  createScheduledSendStore,
  type PrismaClient,
  type ScheduledRecord,
  type ScheduledSendStore,
} from "@opensuite/db";
import type { JmapClient, Session } from "@opensuite/jmap";

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
  work: (beginWrite: () => void) => Promise<T>,
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
    const result = await work(() => {
      state.writing = true;
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

function matchesSubmission(
  submission: {
    emailId: string;
    identityId: string;
    sendAt: string;
    envelope: { mailFrom: { parameters: Record<string, string> | null } };
  },
  row: ScheduledRecord,
) {
  return (
    submission.emailId === row.draftId &&
    submission.identityId === row.identityId &&
    submission.envelope.mailFrom.parameters?.["ENVID"] === row.id &&
    (row.submissionId !== null ||
      Math.abs(Date.parse(submission.sendAt) - row.releaseAt.getTime()) <=
        120_000)
  );
}
async function findSubmission(
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
  return submission;
}

const Capability = z.object({
  maxDelayedSend: z.number().int().nonnegative(),
  submissionExtensions: z.record(z.string(), z.unknown()),
});
function delaySeconds(
  c: MailConnection,
  delivery: ScheduleDelivery,
  now: number,
  reject: (kind: "validation" | "unavailable") => never,
) {
  const releaseTime =
    delivery.type === "delay"
      ? now + delivery.seconds * 1000
      : Date.parse(delivery.at);
  const seconds = Math.ceil((releaseTime - now) / 1000);
  const capability = Capability.safeParse(
    c.session.accounts[c.id]?.accountCapabilities[
      "urn:ietf:params:jmap:submission"
    ],
  );
  if (
    !capability.success ||
    !("FUTURERELEASE" in capability.data.submissionExtensions) ||
    !("DSN" in capability.data.submissionExtensions)
  )
    return reject("unavailable");
  if (!(
    seconds >= 1 &&
    seconds <= Math.min(2_592_000, capability.data.maxDelayedSend)
  ))
    return reject("validation");
  return { release: releaseTime, seconds, max: capability.data.maxDelayedSend };
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
export function createGuards(db: PrismaClient) {
  const store = createScheduledSendStore(db);
  return {
    scheduledStore: store,
    guardDraft: <T>(
      c: MailConnection,
      ids: string[],
      work: (beginWrite: () => void) => Promise<T>,
      conflict: () => never,
    ) => guardDraft(store, c, ids, work, conflict),
    findSubmission,
    delaySeconds,
    submit,
    reserve,
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
