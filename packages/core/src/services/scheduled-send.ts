import { z } from "zod";
import {
  ScheduledSchema,
  type Mailbox,
  type ScheduleDelivery,
} from "@opensuite/contracts";
import type { ScheduledRecord, ScheduledSendStore } from "@opensuite/db";
import type { Actor } from "./accounts.ts";
import { fail, value, type createJmapAccess } from "./jmap-access.ts";

type Access = ReturnType<typeof createJmapAccess>;
type Connection = Awaited<ReturnType<Access["connect"]>>;
type EmailResult = Awaited<ReturnType<Connection["client"]["emails"]>>;
type Email = Extract<EmailResult, { value: unknown }>["value"]["list"][number];
const submissionCapability = "urn:ietf:params:jmap:submission";
type Dependencies = {
  store: ScheduledSendStore | undefined;
  connect: (actor: Actor, accountId: string) => Promise<Connection>;
  boxes: (connection: Connection) => Promise<Mailbox[]>;
  getDraft: (
    connection: Connection,
    id: string,
    boxes: Mailbox[],
  ) => Promise<Email>;
  now: () => number;
  run: Access["run"];
  findSubmission: (
    c: Connection,
    row: ScheduledRecord,
    store: ScheduledSendStore,
  ) => Promise<
    | {
        id: string;
        sendAt: string;
        undoStatus: "pending" | "final" | "canceled";
      }
    | undefined
  >;
  sender: (
    c: Connection,
    email: Email,
  ) => Promise<{
    from: string;
    identityId: string;
    recipients: { email: string }[];
  }>;
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
const dto = (row: ScheduledRecord) =>
  ScheduledSchema.parse({
    id: row.id,
    draftId: row.draftId,
    threadId: row.threadId,
    releaseAt: row.releaseAt.toISOString(),
    state: row.state === "preparing" ? "creating" : row.state,
  });
const requiredStore = (deps: Dependencies) => deps.store ?? fail("unavailable");
const Capability = z.object({
  maxDelayedSend: z.number().int().nonnegative(),
  submissionExtensions: z.record(z.string(), z.unknown()),
});
function delaySeconds(c: Connection, delivery: ScheduleDelivery, now: number) {
  const releaseTime =
    delivery.type === "delay"
      ? now + delivery.seconds * 1000
      : Date.parse(delivery.at);
  const seconds = Math.ceil((releaseTime - now) / 1000);
  const capability = Capability.safeParse(
    c.session.accounts[c.id]?.accountCapabilities[submissionCapability],
  );
  if (
    !capability.success ||
    !("FUTURERELEASE" in capability.data.submissionExtensions) ||
    !("DSN" in capability.data.submissionExtensions)
  )
    return fail("unavailable");
  if (!(
    seconds >= 1 &&
    seconds <= Math.min(2_592_000, capability.data.maxDelayedSend)
  ))
    return fail("validation");
  return { release: releaseTime, seconds, max: capability.data.maxDelayedSend };
}
async function prepare(
  deps: Dependencies,
  c: Connection,
  draftId: string,
  requestId: string,
  delivery: ScheduleDelivery,
): Promise<Prepared> {
  const store = requiredStore(deps);
  const timing = delaySeconds(c, delivery, deps.now());
  const email = await deps.getDraft(c, draftId, await deps.boxes(c));
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
async function reserve(deps: Dependencies, p: Prepared) {
  const { store, c, requestId, draftId, email, identityId, seconds, encoded } =
    p;
  if (
    !(await store.reserve({
      id: requestId,
      userId: c.owner,
      accountId: c.id,
      draftId,
      threadId: email.threadId,
      identityId,
      releaseAt: new Date(deps.now() + seconds * 1000),
      previousIds: [],
      state: "preparing",
      requestDelivery: encoded,
    }))
  )
    fail("conflict");
  try {
    await deps.getDraft(c, draftId, await deps.boxes(c));
    const previous = value(
      await c.client.scheduled.submissionIds(c.session, c.id, draftId),
    );
    if (previous.total === undefined || previous.total !== previous.ids.length)
      fail("unavailable");
    if (
      !(await store.transition(requestId, ["preparing"], "creating", {
        previousIds: previous.ids,
      }))
    )
      fail("conflict");
  } catch (error) {
    const row = await store.get(c.owner, requestId);
    if (row) await store.finish(row, ["preparing"], "failed");
    throw error;
  }
  return undefined;
}
async function submit(deps: Dependencies, p: Prepared) {
  const {
    store,
    c,
    requestId,
    draftId,
    email,
    identityId,
    from,
    recipients,
    seconds,
  } = p;
  const fallback = ScheduledSchema.parse({
    id: requestId,
    draftId,
    threadId: email.threadId,
    releaseAt: new Date(deps.now() + seconds * 1000).toISOString(),
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
    return row ? dto(row) : fallback;
  } catch {
    return fallback;
  }
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
    return dto(existing);
  }
  const prepared = await prepare(deps, c, draftId, requestId, delivery);
  await reserve(deps, prepared);
  return submit(deps, prepared);
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
    return found ? dto(found) : fail("unavailable");
  }
  if (row.state !== "pending" || !row.submissionId) return dto(row);
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
      return dto(found ?? { ...row, state: "unknown" });
    } catch {
      return dto({ ...row, state: "unknown" });
    }
  }
  const found = await store.get(actor.id, id);
  return found ? dto(found) : fail("unavailable");
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
        return { scheduled: (await store.list(c.owner, c.id)).map(dto) };
      }),
    cancelScheduled: (actor: Actor, accountId: string, id: string) =>
      deps.run(() => cancel(deps, actor, accountId, id)),
    reconcileScheduled: () => reconcile(deps),
  };
}
