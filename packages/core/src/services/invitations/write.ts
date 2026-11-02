import { randomUUID } from "node:crypto";
import type { Actor } from "../accounts.ts";
import { fail, value as jmapValue } from "../jmap-access.ts";
import type { InvitationContext, Operation } from "./context.ts";
import { writeEvent } from "./write-event.ts";
import { send } from "./send.ts";

export async function writeReserved(
  ctx: InvitationContext,
  actor: Actor,
  accountId: string,
  operation: Operation,
): Promise<void> {
  const store = ctx.intentions();
  if (operation.phase !== "reserved") return;
  const c = await ctx.calendar(actor, accountId);
  if (c.id !== operation.series.accountId) return fail("forbidden");
  const calendars = jmapValue(await c.client.calendars(c.session, c.id)).list;
  const selected = calendars.find(
    (item) => item.id === operation.series.calendarId,
  );
  if (!selected || selected.myRights?.mayWriteAll !== true)
    return fail("forbidden");
  const event = await ctx.parsedCalendar(c, operation.calendar);
  if (event["uid"] !== operation.series.uid) return fail("conflict");
  const generation = `calendarWriting:${randomUUID()}`;
  if (!(await store.transition(actor.id, operation.id, "reserved", generation)))
    return;
  const eventId = await writeEvent({
    ctx,
    actor,
    accountId,
    connection: c,
    operation,
    event,
    generation,
  });
  if (
    !(await store.transition(
      actor.id,
      operation.id,
      generation,
      "calendarWritten",
      { eventId, calendar: operation.organizerCalendar ?? operation.calendar },
    ))
  )
    return fail("conflict");
  const written = await store.operation(actor.id, operation.id);
  if (!written) return fail("unavailable");
  const snapshot = await ctx.verifyCalendar(actor, accountId, written);
  if (
    !(await store.transition(
      actor.id,
      operation.id,
      "calendarWritten",
      "calendarApplied",
      { eventSnapshot: snapshot },
    ))
  )
    return fail("conflict");
  await send(ctx, actor, accountId, operation.id);
}
