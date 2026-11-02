import { randomUUID } from "node:crypto";
import type { Actor } from "../accounts.ts";
import { fail, value } from "../jmap-access.ts";
import { digest, protocolValue } from "./state.ts";
import type {
  OrganizerContext,
  OrganizerOperation,
} from "./organizer-context.ts";

async function writeValue<T>(
  ctx: OrganizerContext,
  actor: Actor,
  op: OrganizerOperation,
  generation: string,
  result: Parameters<typeof value<T>>[0],
) {
  if (
    result.isErr() &&
    (result.error.kind === "set" || result.error.kind === "method") &&
    result.error.method === "CalendarEvent/set" &&
    result.error.type !== "stateMismatch"
  )
    await ctx.organized.reject(actor.id, op.id, generation);
  return value(result);
}
async function writeWithGeneration<T>(
  ctx: OrganizerContext,
  actor: Actor,
  op: OrganizerOperation,
  write: () => Promise<Parameters<typeof value<T>>[0]>,
) {
  const generation = `writing:${randomUUID()}`;
  if (!(await ctx.organized.transition(actor.id, op.id, op.phase, generation)))
    return;
  await writeValue(ctx, actor, op, generation, await write());
}
async function conflictingBaseline(
  ctx: OrganizerContext,
  actor: Actor,
  op: OrganizerOperation,
) {
  // An incompatible current event fences any earlier ifInState write. The
  // phase comparison also prevents this recovery from releasing a newer writer.
  await ctx.organized.reject(actor.id, op.id, op.phase);
  return fail("conflict");
}
async function applyEvent(
  ctx: OrganizerContext,
  actor: Actor,
  accountId: string,
  op: OrganizerOperation,
) {
  const c = await ctx.calendar(actor, accountId);
  if (op.series.accountId !== c.id) return fail("forbidden");
  const selected = value(await c.client.calendars(c.session, c.id)).list.find(
    (item) => item.id === op.series.calendarId,
  );
  if (!selected || selected.myRights?.mayWriteAll !== true)
    return fail("forbidden");
  const parsed = await ctx.parsedCalendar(c, op.calendar);
  if (parsed["uid"] !== op.series.uid) return fail("conflict");
  if (op.series.eventId) {
    const response = value(
      await c.client.calendarEvents(c.session, c.id, [op.series.eventId]),
    );
    const event = response.list.find((item) => item.id === op.series.eventId);
    if (!event) return conflictingBaseline(ctx, actor, op);
    const current = { event, state: response.state };
    const raw = await ctx.rawCalendar(actor, accountId, op.series.uid);
    if (
      current.event.uid !== op.series.uid ||
      !current.event.calendarIds[op.series.calendarId] ||
      !raw ||
      digest(raw) !== op.baseSnapshot
    )
      return conflictingBaseline(ctx, actor, op);
    const removable = [
      "participants",
      "replyTo",
      "locations",
      "recurrenceRules",
      "excludedRecurrenceRules",
      "recurrenceOverrides",
      "virtualLocations",
      "links",
    ];
    const removed = Object.fromEntries(
      removable
        .filter(
          (key) =>
            current.event[key] !== null &&
            current.event[key] !== undefined &&
            !(key in parsed),
        )
        .map((key) => [key, null]),
    );
    await writeWithGeneration(ctx, actor, op, () =>
      c.client.updateCalendarEvent(
        c.session,
        c.id,
        current.event.id,
        { ...removed, ...parsed },
        current.state,
      ),
    );
    return undefined;
  }
  const scanned = await ctx.eventsWithUid(c, op.series.uid);
  if (scanned.found.length) return conflictingBaseline(ctx, actor, op);
  await writeWithGeneration(ctx, actor, op, () =>
    c.client.createCalendarEvent(
      c.session,
      c.id,
      { ...parsed, calendarIds: { [op.series.calendarId]: true } },
      scanned.state,
    ),
  );
  return undefined;
}
async function recognizeWrite(
  ctx: OrganizerContext,
  actor: Actor,
  accountId: string,
  op: OrganizerOperation,
) {
  const c = await ctx.calendar(actor, accountId);
  if (c.id !== op.series.accountId) fail("forbidden");
  const matches = (await ctx.eventsWithUid(c, op.series.uid)).found;
  if (matches.length !== 1 || !matches[0]?.calendarIds[op.series.calendarId])
    return;
  const raw = await ctx.rawCalendar(actor, accountId, op.series.uid);
  if (!raw || !ctx.sameCalendar(raw, op.calendar)) return;
  await ctx.organized.calendarWritten(
    actor.id,
    op.id,
    op.phase,
    matches[0].id,
    digest(raw),
    protocolValue(ctx.organizerProtocol.attendees(op.calendar)).map(
      (item) => item.email,
    ),
  );
}
export async function writeOrganizerCalendar(
  ctx: OrganizerContext,
  actor: Actor,
  accountId: string,
  op: OrganizerOperation,
) {
  if (op.phase !== "reserved" && !op.phase.startsWith("writing:")) return;
  if (op.phase.startsWith("writing:")) {
    await recognizeWrite(ctx, actor, accountId, op);
    const current = await ctx.organized.operation(actor.id, op.id);
    if (!current || current.phase !== op.phase) return;
  }
  await applyEvent(ctx, actor, accountId, op);
  const current = await ctx.organized.operation(actor.id, op.id);
  if (current?.phase.startsWith("writing:"))
    await recognizeWrite(ctx, actor, accountId, current);
}
