import { randomUUID } from "node:crypto";
import { z } from "zod";
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
  work: () => Promise<T>,
  conflict: () => never,
): Promise<T> {
  const token = randomUUID();
  const acquired: string[] = [];
  let completed = false;
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
    const result = await work();
    completed = true;
    return result;
  } catch (error) {
    if (KnownError.safeParse(error).success) completed = true;
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

export function createGuards(db: PrismaClient) {
  const store = createScheduledSendStore(db);
  return {
    scheduledStore: store,
    guardDraft: <T>(
      c: MailConnection,
      ids: string[],
      work: () => Promise<T>,
      conflict: () => never,
    ) => guardDraft(store, c, ids, work, conflict),
    findSubmission,
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
