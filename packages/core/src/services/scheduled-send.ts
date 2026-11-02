import {
  scheduledDto,
  type Mailbox,
  type ScheduleDelivery,
  type Scheduled,
} from "@opensuite/contracts";
import type { ScheduledRecord, ScheduledSendStore } from "@opensuite/db";
import type { Actor } from "./accounts.ts";
import { fail, value, type createJmapAccess } from "./jmap-access.ts";

type Access = ReturnType<typeof createJmapAccess>;
type Connection = Awaited<ReturnType<Access["connect"]>>;
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
type Timing = { release: number; seconds: number; max: number };
type Reject = (kind: "validation" | "unavailable") => never;
type Reservation = Omit<ScheduledRecord, "submissionId" | "createdAt">;
type Dependencies = {
  store: ScheduledSendStore | undefined;
  connect: (actor: Actor, accountId: string) => Promise<Connection>;
  boxes: (c: Connection) => Promise<Mailbox[]>;
  now: () => number;
  run: Access["run"];
  findSubmission: (
    c: Connection,
    row: ScheduledRecord,
    store: ScheduledSendStore,
  ) => Promise<Submission | undefined>;
  sender: (c: Connection, email: Email) => Promise<Sender>;
  delaySeconds: (
    c: Connection,
    d: ScheduleDelivery,
    n: number,
    reject: Reject,
  ) => Timing;
  reserve: (
    store: ScheduledSendStore,
    input: Reservation,
    verify: () => Promise<string[]>,
    conflict: () => never,
  ) => Promise<void>;
  submit: (
    c: Connection,
    store: ScheduledSendStore,
    plan: Pick<
      Prepared,
      "requestId" | "draftId" | "identityId" | "from" | "recipients" | "seconds"
    > & { threadId: string },
    now: number,
  ) => Promise<Scheduled>;
};
export type ScheduledAdapters = {
  scheduledStore?: ScheduledSendStore;
  guardDraft?: <T>(
    c: Connection,
    ids: string[],
    work: () => Promise<T>,
    conflict: () => never,
  ) => Promise<T>;
  findSubmission?: Dependencies["findSubmission"];
  delaySeconds?: Dependencies["delaySeconds"];
  submit?: Dependencies["submit"];
  reserve?: Dependencies["reserve"];
};
type Prepared = {
  c: Connection;
  store: ScheduledSendStore;
  draftId: string;
  requestId: string;
  encoded: string;
  email: Email;
  identityId: string;
  from: string;
  recipients: { email: string }[];
  seconds: number;
};
const requiredStore = (deps: Dependencies) => deps.store ?? fail("unavailable");
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
  guard: <T>(
    c: Connection,
    ids: string[],
    work: () => Promise<T>,
  ) => Promise<T>;
}) {
  return <T>(
    actor: Actor,
    accountId: string,
    id: string,
    work: (c: Connection, list: Mailbox[], email: Email) => Promise<T>,
  ) =>
    deps.run(async () => {
      const c = await deps.connect(actor, accountId);
      return deps.guard(c, [id], async () => {
        const list = await deps.boxes(c);
        return work(c, list, await getDraft(c, id, list));
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
  if (!identity) return fail("unavailable");
  if (aliasId && !(await options.beforeAliasSend?.(c.owner, aliasId)))
    return fail("rate_limited");
  return {
    from,
    identityId: identity.id,
    recipients: recipients.map((item) => ({ email: item.email })),
  };
}

async function prepare(
  deps: Dependencies,
  c: Connection,
  draftId: string,
  requestId: string,
  delivery: ScheduleDelivery,
): Promise<Prepared> {
  const store = requiredStore(deps);
  const timing = deps.delaySeconds(c, delivery, deps.now(), fail);
  const email = await getDraft(c, draftId, await deps.boxes(c));
  const { from, identityId, recipients } = await deps.sender(c, email);
  const seconds =
    delivery.type === "at"
      ? Math.ceil((timing.release - deps.now()) / 1000)
      : timing.seconds;
  if (seconds < 1 || seconds > timing.max) return fail("validation");
  return {
    c,
    store,
    draftId,
    requestId,
    encoded: JSON.stringify(delivery),
    email,
    identityId,
    from,
    recipients,
    seconds,
  };
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
  const c = await deps.connect(actor, accountId);
  const existing = await store.get(actor.id, requestId);
  if (existing) {
    if (
      existing.accountId !== c.id ||
      existing.draftId !== draftId ||
      existing.requestDelivery !== JSON.stringify(delivery)
    )
      return fail("conflict");
    return scheduledDto(existing);
  }
  const prepared = await prepare(deps, c, draftId, requestId, delivery);
  await deps.reserve(
    store,
    {
      id: requestId,
      userId: c.owner,
      accountId: c.id,
      draftId,
      threadId: prepared.email.threadId,
      identityId: prepared.identityId,
      releaseAt: new Date(deps.now() + prepared.seconds * 1000),
      previousIds: [],
      state: "preparing",
      requestDelivery: prepared.encoded,
    },
    async () => {
      await getDraft(c, draftId, await deps.boxes(c));
      const previous = value(
        await c.client.scheduled.submissionIds(c.session, c.id, draftId),
      );
      if (
        previous.total === undefined ||
        previous.total !== previous.ids.length
      )
        return fail("unavailable");
      return previous.ids;
    },
    () => fail("conflict"),
  );
  return deps.submit(
    prepared.c,
    prepared.store,
    { ...prepared, threadId: prepared.email.threadId },
    deps.now(),
  );
}
async function current(
  deps: Dependencies,
  actor: Actor,
  accountId: string,
  id: string,
) {
  const store = requiredStore(deps);
  const c = await deps.connect(actor, accountId);
  const row = await store.get(actor.id, id);
  if (!row || row.accountId !== c.id) return fail("not_found");
  return { c, row, store };
}
async function cancel(
  deps: Dependencies,
  actor: Actor,
  accountId: string,
  id: string,
) {
  const { c, row, store } = await current(deps, actor, accountId, id);
  if (row.state === "pending" && row.releaseAt.getTime() <= deps.now()) {
    await store.transition(row.id, ["pending"], "releasing");
    const found = await store.get(actor.id, id);
    return found ? scheduledDto(found) : fail("unavailable");
  }
  if (row.state !== "pending" || !row.submissionId) return scheduledDto(row);
  if (await store.transition(row.id, ["pending"], "canceling")) {
    try {
      const canceled = await c.client.scheduled.cancelSubmission(
        c.session,
        c.id,
        row.submissionId,
      );
      if (canceled.isOk()) await store.finish(row, ["canceling"], "canceled");
      else await store.transition(row.id, ["canceling"], "unknown");
      const found = await store.get(actor.id, id);
      return scheduledDto(found ?? { ...row, state: "unknown" });
    } catch {
      return scheduledDto({ ...row, state: "unknown" });
    }
  }
  const found = await store.get(actor.id, id);
  return found ? scheduledDto(found) : fail("unavailable");
}
async function release(
  deps: Dependencies,
  c: Connection,
  row: ScheduledRecord,
  store: ScheduledSendStore,
) {
  const sent =
    (await deps.boxes(c)).find((box) => box.role === "sent")?.id ??
    fail("not_found");
  const updated = await c.client.updateEmail(c.session, c.id, row.draftId, {
    mailboxIds: { [sent]: true },
    "keywords/$draft": null,
    "keywords/$seen": true,
  });
  if (updated.isOk()) await store.finish(row, ["releasing"], "sent");
}
async function releaseDue(
  deps: Dependencies,
  c: Connection,
  row: ScheduledRecord,
  store: ScheduledSendStore,
) {
  if (
    row.releaseAt.getTime() <= deps.now() &&
    (await store.transition(row.id, ["pending"], "releasing"))
  )
    await release(deps, c, { ...row, state: "releasing" }, store);
}
async function reconcileOne(
  deps: Dependencies,
  row: ScheduledRecord,
): Promise<void> {
  const store = requiredStore(deps);
  const c = await deps.connect(
    { id: row.userId, email: "", role: "user" },
    "default",
  );
  if (c.id !== row.accountId) return;
  if (row.state === "preparing") {
    if (row.createdAt && row.createdAt.getTime() <= deps.now() - 300_000)
      await store.finish(row, ["preparing"], "failed");
    return;
  }
  if (row.state === "releasing") return release(deps, c, row, store);
  if (row.state === "pending") return releaseDue(deps, c, row, store);
  const found = await deps.findSubmission(c, row, store);
  if (!found) return;
  if (found.undoStatus === "canceled")
    await store.finish(row, ["creating", "unknown", "canceling"], "canceled");
  else if (found.undoStatus === "final") {
    if (
      await store.transition(
        row.id,
        ["creating", "unknown", "canceling"],
        "releasing",
        { submissionId: found.id },
      )
    )
      await release(
        deps,
        c,
        { ...row, state: "releasing", submissionId: found.id },
        store,
      );
  } else if (
    row.state === "creating" ||
    (row.state === "unknown" && !row.submissionId)
  ) {
    await store.transition(
      row.id,
      [row.state],
      "pending",
      { submissionId: found.id, releaseAt: new Date(found.sendAt) },
      true,
    );
  }
}
async function reconcile(deps: Dependencies) {
  const store = deps.store;
  if (!store) return;
  const page = async (after?: string): Promise<boolean> => {
    const rows = await store.work(after, new Date(deps.now()));
    const failures = await rows.reduce<Promise<boolean>>(
      (previous, row) =>
        previous.then(async (failed) => {
          try {
            await reconcileOne(deps, row);
            return failed;
          } catch {
            return true;
          }
        }),
      Promise.resolve(false),
    );
    const last = rows.at(-1);
    if (rows.length === 100 && last) return (await page(last.id)) || failures;
    return failures;
  };
  if (await page()) throw new Error("scheduled reconciliation incomplete");
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
    reconcileScheduled: () => reconcile(deps),
  };
}
