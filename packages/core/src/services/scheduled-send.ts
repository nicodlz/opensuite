import {
  scheduledDto,
  type Mailbox,
  type ScheduleDelivery,
} from "@opensuite/contracts";
import { randomUUID } from "node:crypto";
import type {
  DraftGuardBegin as BeginWrite,
  ScheduledRecord,
  ScheduledSendStore,
} from "@opensuite/db";
import type { Actor } from "./accounts.ts";
import { fail, value, type createJmapAccess } from "./jmap-access.ts";

type Access = ReturnType<typeof createJmapAccess>;
type Connection = Awaited<ReturnType<Access["connect"]>>;
type Connect = (actor: Actor, accountId: string) => Promise<Connection>;
type Sweep = (
  store: ScheduledSendStore,
  connect: Connect,
  now: () => number,
  visit: (row: ScheduledRecord) => Promise<void>,
) => Promise<void>;
type DraftGuard = <T>(
  c: Connection,
  ids: string[],
  work: (beginWrite: BeginWrite) => Promise<T>,
) => Promise<T>;
type EmailResult = Awaited<ReturnType<Connection["client"]["emails"]>>;
type Email = Extract<EmailResult, { value: unknown }>["value"]["list"][number];
type Submission = {
  id: string;
  sendAt: string;
  undoStatus: "pending" | "final" | "canceled";
};
type Sender = {
  from: string;
  identityId: string;
  recipients: { email: string }[];
};
export type ScheduledWorkerContext = {
  store: ScheduledSendStore;
  connect: Connect;
  boxes: (c: Connection) => Promise<Mailbox[]>;
  draft: (c: Connection, id: string) => Promise<Email>;
  now: () => number;
  sender: (
    c: Connection,
    email: Email,
    forRelease?: boolean,
  ) => Promise<Sender>;
  reconcileSubmission: (
    c: Connection,
    row: ScheduledRecord,
    store: ScheduledSendStore,
  ) => Promise<Submission | undefined>;
};
type Dependencies = {
  store: ScheduledSendStore | undefined;
  connect: Connect;
  boxes: (c: Connection) => Promise<Mailbox[]>;
  now: () => number;
  run: Access["run"];
  sweep: Sweep;
  reconcileSubmission: (
    c: Connection,
    row: ScheduledRecord,
    store: ScheduledSendStore,
  ) => Promise<Submission | undefined>;
  sender: (
    c: Connection,
    email: Email,
    forRelease?: boolean,
  ) => Promise<Sender>;
  processRow?:
    | ((row: ScheduledRecord, context: ScheduledWorkerContext) => Promise<void>)
    | undefined;
};
export type ScheduledAdapters = {
  scheduledStore?: ScheduledSendStore;
  guardDraft?: <T>(
    c: Connection,
    ids: string[],
    work: (beginWrite: BeginWrite) => Promise<T>,
    conflict: () => never,
  ) => Promise<T>;
  reconcileSubmission?: Dependencies["reconcileSubmission"];
  processRow?: Dependencies["processRow"];
  sweep?: Sweep;
};
const requiredStore = (deps: Dependencies) => deps.store ?? fail("unavailable");
const noWriteGuard = () => Promise.resolve(undefined);
export function draftGuard(
  store: ScheduledSendStore | undefined,
  guarded: ScheduledAdapters["guardDraft"],
): DraftGuard {
  return (c, ids, work) => {
    if (!store) return work(noWriteGuard);
    if (!guarded) return fail("unavailable");
    return guarded(c, ids, work, () => fail("conflict"));
  };
}
export async function getDraft(c: Connection, id: string, boxes: Mailbox[]) {
  const draftBox =
    boxes.find((box) => box.role === "drafts")?.id ?? fail("not_found");
  const email = value(await c.client.emails(c.session, c.id, [id])).list[0];
  if (!email || !email.keywords["$draft"] || !email.mailboxIds[draftBox])
    return fail("not_found");
  return email;
}
export function draftOperations(deps: {
  connect: Dependencies["connect"];
  run: Dependencies["run"];
  boxes: Dependencies["boxes"];
  guard: DraftGuard;
}) {
  return <T>(
    actor: Actor,
    accountId: string,
    id: string,
    work: (
      c: Connection,
      list: Mailbox[],
      email: Email,
      beginWrite: BeginWrite,
    ) => Promise<T>,
  ) =>
    deps.run(async () => {
      const c = await deps.connect(actor, accountId);
      return deps.guard(c, [id], async (beginWrite) => {
        const list = await deps.boxes(c);
        return work(c, list, await getDraft(c, id, list), beginWrite);
      });
    });
}
export async function senderFor(
  c: Connection,
  email: Email,
  options: {
    canSendAs?:
      ((userId: string, address: string) => Promise<string | null>) | undefined;
    beforeAliasSend?:
      ((userId: string, aliasId: string) => Promise<boolean>) | undefined;
  },
) {
  const recipients = [email.to, email.cc, email.bcc].flatMap((a) => a ?? []);
  if (!recipients.length) return fail("validation");
  const from = email.from?.[0]?.email.toLowerCase() ?? c.address.toLowerCase();
  const aliasId =
    from === c.address.toLowerCase()
      ? null
      : await options.canSendAs?.(c.owner, from);
  if (from !== c.address.toLowerCase() && !aliasId) return fail("forbidden");
  const identity = value(await c.client.identities(c.session, c.id)).list.find(
    (item) => item.email.toLowerCase() === from,
  );
  if (!identity) return fail("forbidden");
  if (aliasId && !(await options.beforeAliasSend?.(c.owner, aliasId)))
    return fail("rate_limited");
  return {
    from,
    identityId: identity.id,
    recipients: recipients.map((item) => ({ email: item.email })),
  };
}

function sameSchedule(
  row: ScheduledRecord,
  accountId: string,
  draftId: string,
  delivery: ScheduleDelivery,
) {
  if (
    row.accountId !== accountId ||
    row.draftId !== draftId ||
    row.requestDelivery !== JSON.stringify(delivery)
  )
    return fail("conflict");
  return scheduledDto(row);
}
function releaseTime(delivery: ScheduleDelivery, now: number) {
  const release =
    delivery.type === "delay"
      ? now + delivery.seconds * 1000
      : Date.parse(delivery.at);
  if (
    !Number.isFinite(release) ||
    release <= now ||
    release > now + 2_592_000_000
  )
    return fail("validation");
  return release;
}

async function schedule(
  deps: Dependencies,
  actor: Actor,
  accountId: string,
  draftId: string,
  requestId: string,
  delivery: ScheduleDelivery,
) {
  const store = requiredStore(deps);
  if (!deps.processRow) return fail("unavailable");
  const c = await deps.connect(actor, accountId);
  const existing = await store.get(actor.id, requestId);
  if (existing) return sameSchedule(existing, c.id, draftId, delivery);
  const now = deps.now();
  const release = releaseTime(delivery, now);
  const email = await getDraft(c, draftId, await deps.boxes(c));
  const sender = await deps.sender(c, email);
  const token = randomUUID();
  const reserved = await store.reserve({
    id: requestId,
    userId: c.owner,
    accountId: c.id,
    draftId,
    threadId: email.threadId,
    identityId: sender.identityId,
    senderAddress: sender.from,
    releaseAt: new Date(release),
    requestDelivery: JSON.stringify(delivery),
    leaseToken: token,
    leaseUntil: new Date(now + 60_000),
  });
  if (!reserved) {
    const concurrent = await store.get(actor.id, requestId);
    return concurrent
      ? sameSchedule(concurrent, c.id, draftId, delivery)
      : fail("conflict");
  }
  const row = await store.get(c.owner, requestId);
  if (!row) return fail("unavailable");
  try {
    const current = await getDraft(c, draftId, await deps.boxes(c));
    const currentSender = await deps.sender(c, current);
    if (
      currentSender.from !== sender.from ||
      currentSender.identityId !== sender.identityId
    )
      return fail("conflict");
    await store.queue(requestId, token);
  } catch (error) {
    if (await store.finish(row, ["preparing"], "canceled")) throw error;
  }
  const found = await store.get(c.owner, requestId);
  return found ? scheduledDto(found) : fail("unavailable");
}

async function cancel(
  deps: Dependencies,
  actor: Actor,
  accountId: string,
  id: string,
) {
  const store = requiredStore(deps);
  const c = await deps.connect(actor, accountId);
  const row = await store.get(actor.id, id);
  if (!row || row.accountId !== c.id) return fail("not_found");
  // The compare-and-swap competes with the worker's handoff. Once handoff
  // starts, return the actual uncertain/sent state rather than claiming undo.
  if (!row.submissionId)
    await store.finish(row, ["pending", "preparing"], "canceled");
  const found = await store.get(actor.id, id);
  return found ? scheduledDto(found) : fail("unavailable");
}

async function reconcile(deps: Dependencies) {
  const processRow = deps.processRow;
  if (!deps.store || !processRow) return;
  const context: ScheduledWorkerContext = {
    store: deps.store,
    connect: deps.connect,
    boxes: deps.boxes,
    draft: async (c, id) => getDraft(c, id, await deps.boxes(c)),
    now: deps.now,
    sender: deps.sender,
    reconcileSubmission: deps.reconcileSubmission,
  };
  await deps.sweep(deps.store, deps.connect, deps.now, (row) =>
    processRow(row, context),
  );
}
export function createScheduledSend(deps: Dependencies) {
  return {
    schedule: (
      actor: Actor,
      accountId: string,
      draftId: string,
      requestId: string,
      delivery: ScheduleDelivery,
    ) =>
      deps.run(() =>
        schedule(deps, actor, accountId, draftId, requestId, delivery),
      ),
    scheduled: (actor: Actor, accountId: string) =>
      deps.run(async () => {
        const store = requiredStore(deps);
        const c = await deps.connect(actor, accountId);
        const rows = await store.list(c.owner, c.id);
        return { scheduled: rows.map(scheduledDto) };
      }),
    cancelScheduled: (actor: Actor, accountId: string, id: string) =>
      deps.run(() => cancel(deps, actor, accountId, id)),
    draftGuardStatus: (actor: Actor, accountId: string, draftId: string) =>
      deps.run(async () => {
        const c = await deps.connect(actor, accountId);
        return {
          state: await requiredStore(deps).guardStatus(actor.id, c.id, draftId),
        };
      }),
    reconcileScheduled: () => reconcile(deps),
  };
}
