import type { Actor } from "../accounts.ts";
import { fail, value as jmapValue } from "../jmap-access.ts";
import type { Connection, InvitationContext, Operation } from "./context.ts";
import { digest, status } from "./state.ts";
import { writeReserved } from "./write.ts";
import { send } from "./send.ts";

async function reconcileSubmission(
  ctx: InvitationContext,
  actor: Actor,
  accountId: string,
  operationId: string,
  operation: Operation,
) {
  const store = ctx.intentions();
  if (operation.phase === "sending" && operation.draftId) {
    const draftId = operation.draftId;
    const m = await ctx.mail(actor, accountId);
    const found = jmapValue(
      await m.client.submissionQuery(m.session, m.id, draftId),
    );
    if (found.ids.length) {
      const submissions = jmapValue(
        await m.client.submissions(m.session, m.id, found.ids),
      );
      if (
        submissions.notFound.length === 0 &&
        submissions.list.some(
          (item) =>
            item.emailId === draftId &&
            item.identityId === operation.identityId &&
            item.undoStatus !== "canceled" &&
            item.envelope?.mailFrom.email.toLowerCase() ===
              operation.series.recipient &&
            item.envelope.rcptTo.length === 1 &&
            item.envelope.rcptTo[0]?.email.toLowerCase() ===
              operation.series.organizer,
        )
      )
        await store.transition(actor.id, operationId, "sending", "sent", {
          release: true,
        });
    }
  }
}

async function retryCalendar(
  ctx: InvitationContext,
  actor: Actor,
  accountId: string,
  operation: Operation,
  matchedId: string | undefined,
  raw: string | null,
) {
  const store = ctx.intentions();
  const safeToRetry = operation.series.eventId
    ? matchedId === operation.series.eventId &&
      raw !== null &&
      digest(raw) === (operation.baseSnapshot ?? operation.series.eventSnapshot)
    : matchedId === undefined;
  if (!safeToRetry) {
    await store.transition(
      actor.id,
      operation.id,
      operation.phase,
      "rejected",
      { release: true },
    );
    return;
  }
  if (
    !(await store.transition(
      actor.id,
      operation.id,
      operation.phase,
      "reserved",
    ))
  )
    return;
  const current = await store.operation(actor.id, operation.id);
  if (current) await writeReserved(ctx, actor, accountId, current);
}

async function reconcileCalendar(
  ctx: InvitationContext,
  actor: Actor,
  accountId: string,
  c: Connection,
  operation: Operation,
) {
  const store = ctx.intentions();
  if (
    operation.phase !== "calendarWriting" &&
    !operation.phase.startsWith("calendarWriting:")
  )
    return;
  const matches = (await ctx.eventsWithUid(c, operation.series.uid)).found;
  const match = matches[0];
  if (
    matches.length > 1 ||
    (match && !match.calendarIds[operation.series.calendarId])
  )
    return;
  const raw = match
    ? await ctx.rawCalendar(actor, accountId, operation.series.uid)
    : null;
  if (match && raw && ctx.sameCalendar(raw, operation.calendar)) {
    await store.transition(
      actor.id,
      operation.id,
      operation.phase,
      "calendarWritten",
      {
        eventId: match.id,
        calendar: operation.organizerCalendar ?? operation.calendar,
      },
    );
    return;
  }
  await retryCalendar(ctx, actor, accountId, operation, match?.id, raw);
}

export async function reconcile(
  ctx: InvitationContext,
  actor: Actor,
  accountId: string,
  operationId: string,
) {
  const store = ctx.intentions();
  let operation = await store.operation(actor.id, operationId);
  if (!operation) return fail("not_found");
  const c = await ctx.calendar(actor, accountId);
  if (operation.series.accountId !== c.id) return fail("forbidden");
  if (operation.phase === "reserved") {
    await writeReserved(ctx, actor, accountId, operation);
    operation = await store.operation(actor.id, operationId);
    if (!operation) return fail("not_found");
  }
  await reconcileCalendar(ctx, actor, accountId, c, operation);
  operation = await store.operation(actor.id, operationId);
  if (!operation) return fail("not_found");
  if (operation.phase === "calendarWritten" && operation.series.eventId) {
    const snapshot = await ctx.verifyCalendar(actor, accountId, operation);
    await store.transition(
      actor.id,
      operation.id,
      "calendarWritten",
      "calendarApplied",
      { eventSnapshot: snapshot },
    );
  }
  operation = await store.operation(actor.id, operationId);
  if (!operation) return fail("not_found");
  if (
    operation.phase === "calendarApplied" ||
    operation.phase === "prepared" ||
    operation.phase.startsWith("draftCreating:")
  )
    await send(ctx, actor, accountId, operationId);
  await reconcileSubmission(ctx, actor, accountId, operationId, operation);
  const current = await store.operation(actor.id, operationId);
  return current ? status(current) : fail("unavailable");
}
