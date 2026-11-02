import { randomUUID } from "node:crypto";
import type { OrganizerAction } from "@opensuite/contracts";
import type { OrganizerEdit } from "../../domain/invitations/organizer.ts";
import type { Actor } from "../accounts.ts";
import {
  locate,
  seriesIdOf,
  timing,
  toSeries,
  updatePatch,
  parseLocal,
  toInstant,
} from "../calendar-time.ts";
import { fail, value } from "../jmap-access.ts";
import type { Connection } from "./context.ts";
import type { OrganizerContext } from "./organizer-context.ts";
import { digest, protocolValue } from "./state.ts";

type Prior = Awaited<ReturnType<OrganizerContext["organized"]["series"]>>;
function eventForSeries(
  event: OrganizerAction["event"],
  patch: Record<string, unknown>,
) {
  if ("alerts" in patch) return fail("validation");
  const local = patch["start"];
  if (typeof local !== "string") return event;
  const zone = event.allDay ? "UTC" : event.timeZone;
  const wall = parseLocal(local, zone) ?? fail("validation");
  const start = event.allDay ? wall : toInstant(wall, zone);
  const duration = Date.parse(event.end) - Date.parse(event.start);
  return {
    ...event,
    start: new Date(start).toISOString(),
    end: new Date(start + duration).toISOString(),
  };
}
async function snapshot(
  ctx: OrganizerContext,
  actor: Actor,
  input: OrganizerAction,
  c: Connection,
  calendars: { id: string }[],
  prior: Prior,
  baseSnapshot: string | null,
  time: NonNullable<ReturnType<typeof timing>>,
) {
  if (!prior && input.event.reminder && input.event.reminder !== "none")
    return fail("validation");
  let previous: string | null = null;
  let event = input.event;
  let changes = {
    title: true,
    description: true,
    location: true,
    time: true,
    recurrence: true,
  };
  if (prior?.eventId) {
    const stored = await ctx.getEvent(c, prior.eventId);
    const series =
      toSeries(
        stored.event,
        calendars.map((item) => item.id),
      ) ?? fail("conflict");
    const occurrence =
      locate(series, input.eventId ?? prior.eventId) ?? fail("not_found");
    previous = await ctx.rawCalendar(actor, input.accountId, prior.uid);
    if (
      !previous ||
      digest(previous) !== baseSnapshot ||
      stored.event.uid !== prior.uid ||
      !stored.event.calendarIds[prior.calendarId]
    )
      return fail("conflict");
    const patch = updatePatch(series, occurrence, input.event, time);
    event = eventForSeries(input.event, patch);
    changes = {
      title: "title" in patch,
      description: "description" in patch,
      location: "locations" in patch,
      time: ["start", "duration", "timeZone", "showWithoutTime"].some(
        (key) => key in patch,
      ),
      recurrence: "recurrenceRules" in patch,
    };
  }
  return { previous, changes, event };
}
async function reserve(
  ctx: OrganizerContext,
  actor: Actor,
  input: OrganizerAction,
  accountId: string,
  organizer: string,
  attendees: string[],
  fingerprint: string,
  prior: Prior,
  previous: string | null,
  changes: OrganizerEdit["changes"],
  event: OrganizerAction["event"],
  baseSnapshot: string | null,
  sequenceBase: number,
) {
  const uid = prior?.uid ?? `${randomUUID()}@esuno.local`;
  const sequence = prior ? sequenceBase + 1 : 0;
  const planned = protocolValue(
    ctx.organizerProtocol.prepare({
      previous,
      uid,
      organizer,
      attendees,
      sequence,
      event,
      changes,
      cancelled: input.cancel,
      now: new Date(ctx.access.now()),
    }),
  );
  const op = await ctx.organized.reserve(
    {
      id: prior?.id ?? randomUUID(),
      userId: actor.id,
      accountId,
      uid,
      organizer,
      calendarId: input.event.calendarId,
    },
    {
      id: input.requestId,
      fingerprint,
      calendar: planned.calendar,
      baseSnapshot,
      sequence,
      cancelled: input.cancel,
      deliveries: planned.deliveries,
    },
    prior?.revision ?? null,
  );
  return op ?? fail("conflict");
}
async function targetSeries(
  ctx: OrganizerContext,
  actor: Actor,
  input: OrganizerAction,
  c: Connection,
  organizer: string,
) {
  const calendars = value(await c.client.calendars(c.session, c.id)).list;
  const target =
    calendars.find((item) => item.id === input.event.calendarId) ??
    fail("not_found");
  if (target.myRights?.mayWriteAll !== true) return fail("forbidden");
  const eventId = input.eventId ? seriesIdOf(input.eventId) : null;
  const prior = eventId
    ? await ctx.organized.series(actor.id, c.id, eventId)
    : null;
  if (eventId && !prior) return fail("not_found");
  if (!prior && input.cancel) return fail("validation");
  if (
    prior &&
    (prior.pendingId ||
      prior.cancelled ||
      prior.organizer !== organizer ||
      prior.calendarId !== input.event.calendarId)
  )
    return fail("conflict");
  return { calendars, prior };
}
async function externalBaseline(
  ctx: OrganizerContext,
  actor: Actor,
  input: OrganizerAction,
  prior: Prior,
) {
  if (!prior) return { baseSnapshot: null, sequenceBase: 0 };
  const current = await ctx.rawCalendar(actor, input.accountId, prior.uid);
  if (!current || !prior.calendar) return fail("conflict");
  const sequenceBase = protocolValue(
    ctx.organizerProtocol.rebase(
      prior.calendar,
      current,
      prior.uid,
      prior.organizer,
      true,
    ),
  );
  if (sequenceBase < prior.sequence) return fail("conflict");
  return { baseSnapshot: digest(current), sequenceBase };
}
function preserveExternalFields(
  ctx: OrganizerContext,
  input: OrganizerAction,
  prior: Prior,
  baseSnapshot: string | null,
  prepared: Awaited<ReturnType<typeof snapshot>>,
) {
  const previous = prepared.previous;
  if (!prior?.calendar || !previous || baseSnapshot === prior.snapshot)
    return previous;
  const baseline = protocolValue(ctx.organizerProtocol.fields(prior.calendar));
  if (input.event.title === baseline.title) prepared.changes.title = false;
  if (input.event.description === baseline.description)
    prepared.changes.description = false;
  if (input.event.location.trim() === baseline.location.trim())
    prepared.changes.location = false;
  return protocolValue(
    ctx.organizerProtocol.restoreParticipants(prior.calendar, previous),
  );
}
export async function prepareOrganizer(
  ctx: OrganizerContext,
  actor: Actor,
  input: OrganizerAction,
) {
  const time = timing(input.event) ?? fail("validation");
  const organizer = input.organizer.toLowerCase();
  const attendees = input.attendees.map((item) => item.toLowerCase());
  if (new Set(attendees).size !== attendees.length) return fail("validation");
  await ctx.authorizedSender(actor, input.accountId, organizer);
  const c = await ctx.calendar(actor, input.accountId);
  const fingerprint = digest([actor.id, c.id, input]);
  const existing = await ctx.organized.operation(actor.id, input.requestId);
  if (existing) {
    if (
      existing.fingerprint !== fingerprint ||
      existing.series.accountId !== c.id
    )
      return fail("conflict");
    return existing;
  }
  const target = await targetSeries(ctx, actor, input, c, organizer);
  const prior = target.prior;
  const { baseSnapshot, sequenceBase } = await externalBaseline(
    ctx,
    actor,
    input,
    prior,
  );
  const prepared = await snapshot(
    ctx,
    actor,
    input,
    c,
    target.calendars,
    prior,
    baseSnapshot,
    time,
  );
  const previous = preserveExternalFields(
    ctx,
    input,
    prior,
    baseSnapshot,
    prepared,
  );
  return reserve(
    ctx,
    actor,
    input,
    c.id,
    organizer,
    attendees,
    fingerprint,
    prior,
    previous,
    prepared.changes,
    prepared.event,
    baseSnapshot,
    sequenceBase,
  );
}
