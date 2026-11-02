import type { Actor } from "../accounts.ts";
import { fail, value as jmapValue } from "../jmap-access.ts";
import type { Connection, InvitationContext, Operation } from "./context.ts";
import { digest } from "./state.ts";

type EventWrite = {
  ctx: InvitationContext;
  actor: Actor;
  accountId: string;
  connection: Connection;
  operation: Operation;
  event: Record<string, unknown>;
  generation: string;
};

function updatePatch(
  current: Record<string, unknown>,
  desired: Record<string, unknown>,
) {
  const removable = [
    "locations",
    "virtualLocations",
    "links",
    "recurrenceRules",
    "recurrenceRule",
    "excludedRecurrenceRules",
    "recurrenceOverrides",
  ];
  const removed: Record<string, unknown> = Object.fromEntries(
    removable
      .filter(
        (key) =>
          current[key] !== null &&
          current[key] !== undefined &&
          !(key in desired),
      )
      .map((key) => [key, null]),
  );
  if (current["description"] && !("description" in desired))
    removed["description"] = "";
  return { ...removed, ...desired };
}

async function reject(write: EventWrite) {
  await write.ctx
    .intentions()
    .transition(
      write.actor.id,
      write.operation.id,
      write.generation,
      "rejected",
      { release: true },
    );
}

async function setValue<T>(
  write: EventWrite,
  result: Parameters<typeof jmapValue<T>>[0],
): Promise<T> {
  if (
    result.isErr() &&
    (result.error.kind === "set" || result.error.kind === "method") &&
    result.error.type !== "stateMismatch"
  )
    await reject(write);
  return jmapValue(result);
}

async function updateExisting(write: EventWrite, eventId: string) {
  const { ctx, actor, accountId, connection: c, operation, event } = write;
  const current = await ctx.getEvent(c, eventId);
  if (
    current.event.uid !== operation.series.uid ||
    !current.event.calendarIds[operation.series.calendarId]
  ) {
    await reject(write);
    return fail("conflict");
  }
  const raw = await ctx.rawCalendar(actor, accountId, operation.series.uid);
  if (raw && ctx.sameCalendar(raw, operation.calendar)) return eventId;
  if (
    !raw ||
    digest(raw) !== (operation.baseSnapshot ?? operation.series.eventSnapshot)
  ) {
    await reject(write);
    return fail("conflict");
  }
  await setValue(
    write,
    await c.client.updateCalendarEvent(
      c.session,
      c.id,
      eventId,
      updatePatch(current.event, event),
      current.state,
    ),
  );
  return eventId;
}

async function createNew(write: EventWrite) {
  const { ctx, actor, accountId, connection: c, operation, event } = write;
  const scanned = await ctx.eventsWithUid(c, operation.series.uid);
  if (scanned.found.length) {
    const match = scanned.found.length === 1 ? scanned.found[0] : undefined;
    if (match?.calendarIds[operation.series.calendarId]) {
      const raw = await ctx.rawCalendar(actor, accountId, operation.series.uid);
      if (raw && ctx.sameCalendar(raw, operation.calendar)) return match.id;
    }
    await reject(write);
    return fail("conflict");
  }
  const result = await c.client.createCalendarEvent(
    c.session,
    c.id,
    { ...event, calendarIds: { [operation.series.calendarId]: true } },
    scanned.state,
  );
  return (await setValue(write, result)).id;
}

export function writeEvent(write: EventWrite): Promise<string> {
  const id = write.operation.series.eventId;
  return id ? updateExisting(write, id) : createNew(write);
}
