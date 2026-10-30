// Pagination must be ordered to validate a consistent snapshot.
/* oxlint-disable eslint/no-await-in-loop */
import type { CalendarEvent, JmapClient } from "@opensuite/jmap";
import { JmapCapability } from "@opensuite/jmap";
import type { PlannedCalendarReminder } from "@opensuite/db";
import {
  expand,
  locate,
  parseDuration,
  toInstant,
  toSeries,
  toWall,
} from "./calendar-time.ts";
import {
  createJmapAccess,
  fail,
  value as jmapValue,
  type MailCredentialStore,
} from "./jmap-access.ts";
import type { Actor } from "./accounts.ts";

const DAY = 86_400_000;
const isRecord = (item: unknown): item is Record<string, unknown> =>
  typeof item === "object" && item !== null && !Array.isArray(item);
const record = (item: unknown) => (isRecord(item) ? item : undefined);

type Trigger =
  | { kind: "absolute"; at: number }
  | { kind: "offset"; days: number; ms: number; end: boolean };
function triggerOf(value: unknown): Trigger | undefined {
  const trigger = record(record(value)?.["trigger"]);
  if (
    trigger?.["@type"] === "AbsoluteTrigger" &&
    typeof trigger["when"] === "string" &&
    /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(trigger["when"])
  ) {
    const at = Date.parse(trigger["when"]);
    return Number.isFinite(at) ? { kind: "absolute", at } : undefined;
  }
  const offset = trigger?.["offset"];
  if (
    trigger?.["@type"] !== "OffsetTrigger" ||
    typeof offset !== "string" ||
    !/^[+-]?P(?=\d|T\d)(?:\d+W)?(?:\d+D)?(?:T(?:\d+H)?(?:\d+M)?(?:\d+(?:\.\d+)?S)?)?$/.test(
      offset,
    )
  )
    return undefined;
  if (
    trigger["relativeTo"] !== undefined &&
    trigger["relativeTo"] !== "start" &&
    trigger["relativeTo"] !== "end"
  )
    return undefined;
  const sign = offset.startsWith("-") ? -1 : 1;
  const duration = parseDuration(offset.replace(/^[+-]/, ""));
  return {
    kind: "offset",
    days: duration.days * sign,
    ms: duration.ms * sign,
    end: trigger["relativeTo"] === "end",
  };
}
function alertsFor(event: CalendarEvent, occurrenceId: string) {
  const base = record(event.alerts) ?? {};
  const suffix = occurrenceId.startsWith(`${event.id}~`)
    ? occurrenceId.slice(event.id.length + 1)
    : "";
  const key = suffix
    ? `${suffix.slice(0, 4)}-${suffix.slice(4, 6)}-${suffix.slice(6, 8)}T${suffix.slice(9, 11)}:${suffix.slice(11, 13)}:${suffix.slice(13, 15)}`
    : "";
  const patch = record(event.recurrenceOverrides?.[key]);
  if (!patch) return base;
  let alerts =
    patch["alerts"] === null ? {} : (record(patch["alerts"]) ?? { ...base });
  alerts = { ...alerts };
  for (const [path, value] of Object.entries(patch)) {
    if (!path.startsWith("alerts/")) continue;
    const parts = path
      .slice(7)
      .split("/")
      .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"));
    const id = parts[0];
    if (!id) continue;
    if (parts.length === 1) {
      if (value === null) delete alerts[id];
      else alerts[id] = value;
      continue;
    }
    const alert = { ...record(alerts[id]) };
    if (parts.length === 2) alert[parts[1] ?? ""] = value;
    else if (parts.length === 3 && parts[1] === "trigger")
      alert["trigger"] = {
        ...record(alert["trigger"]),
        [parts[2] ?? ""]: value,
      };
    alerts[id] = alert;
  }
  return alerts;
}

/** Convert JSCalendar alerts (the JMAP representation of VALARM) into UTC jobs. */
export function planEvent(
  event: CalendarEvent,
  calendars: string[],
  from: number,
  until: number,
  timeZone = "UTC",
): PlannedCalendarReminder[] {
  if (
    !event.alerts &&
    !Object.values(event.recurrenceOverrides ?? {}).some((patch) =>
      Object.keys(patch).some(
        (key) => key === "alerts" || key.startsWith("alerts/"),
      ),
    )
  )
    return [];
  const series = toSeries(event, calendars, timeZone);
  if (!series) throw new Error("Unplaceable calendar event");
  const allAlerts = [
    event.alerts,
    ...Object.values(event.recurrenceOverrides ?? {}).map(
      (patch) => patch["alerts"],
    ),
  ];
  let margin = 2 * DAY;
  for (const alerts of allAlerts)
    for (const alert of Object.values(record(alerts) ?? {})) {
      const trigger = triggerOf(alert);
      if (trigger?.kind === "offset")
        margin = Math.max(
          margin,
          Math.abs(trigger.days) * DAY + Math.abs(trigger.ms) + 2 * DAY,
        );
    }
  // A slash patch may change an offset without replacing the alerts object.
  for (const patch of Object.values(event.recurrenceOverrides ?? {}))
    for (const [key, value] of Object.entries(patch)) {
      if (key.startsWith("alerts/")) {
        const segments = key.split("/");
        const candidate =
          segments.length === 2
            ? value
            : segments.length === 3 && segments[2] === "trigger"
              ? { trigger: value }
              : segments.length === 4 &&
                  segments[2] === "trigger" &&
                  segments[3] === "offset" &&
                  typeof value === "string"
                ? { trigger: { "@type": "OffsetTrigger", offset: value } }
                : undefined;
        const trigger = triggerOf(candidate);
        if (trigger?.kind === "offset")
          margin = Math.max(
            margin,
            Math.abs(trigger.days) * DAY + Math.abs(trigger.ms) + 2 * DAY,
          );
      }
    }
  if (margin > 3660 * DAY)
    throw new Error("Calendar alarm offset exceeds planning limit");
  const occurrences = expand(series, from - margin, until + margin);
  const base = locate(series, series.id);
  if (base && !occurrences.some((item) => item.id === base.id))
    occurrences.push(base);
  const planned: PlannedCalendarReminder[] = [];
  for (const occurrence of occurrences) {
    for (const [alarmId, alarm] of Object.entries(
      alertsFor(event, occurrence.id),
    )) {
      const alert = record(alarm);
      if (alert?.["action"] !== "display" && alert?.["action"] !== "audio")
        continue;
      const trigger = triggerOf(alarm);
      if (!trigger) continue;
      // Absolute alarms on recurring events fire once, for the series start.
      if (trigger.kind === "absolute" && occurrence.id !== base?.id) continue;
      const anchor =
        trigger.kind === "offset" && trigger.end
          ? occurrence.end
          : occurrence.start;
      const at =
        trigger.kind === "absolute"
          ? trigger.at
          : toInstant(
              toWall(anchor, series.zone) + trigger.days * DAY,
              series.zone,
            ) + trigger.ms;
      const acknowledged = alert["acknowledged"];
      if (acknowledged !== null && acknowledged !== undefined) {
        if (typeof acknowledged !== "string") continue;
        const acknowledgedAt = Date.parse(acknowledged);
        if (!Number.isFinite(acknowledgedAt) || acknowledgedAt >= at) continue;
      }
      if (at < from || at >= until) continue;
      planned.push({
        calendarId: series.calendarId,
        eventId: event.id,
        uid: event.uid || event.id,
        occurrenceId: occurrence.id,
        recurrenceKey: occurrence.id.startsWith(`${event.id}~`)
          ? occurrence.id.slice(event.id.length + 1)
          : "single",
        alarmId,
        occurrenceStart: new Date(occurrence.start),
        triggerAt: new Date(at),
        title: occurrence.title,
        location: occurrence.location,
        timeZone: series.zone,
        allDay: series.allDay,
      });
    }
  }
  return planned;
}

export function createCalendarReminderSource(dependencies: {
  store: MailCredentialStore;
  origin: string;
  client?: (credential: { address: string; secret: string }) => JmapClient;
}) {
  const access = createJmapAccess(dependencies);
  return {
    async read(
      user: { id: string; email: string; calendarTimeZone?: string },
      from: Date,
      until: Date,
    ) {
      const actor: Actor = { ...user, role: "user" };
      const result = await access.run(async () => {
        const c = await access.connect(
          actor,
          "default",
          JmapCapability.calendars,
        );
        const calendars = jmapValue(
          await c.client.calendars(c.session, c.id),
        ).list.map((item) => item.id);
        const planned: PlannedCalendarReminder[] = [];
        let queryState: string | undefined;
        let eventState: string | undefined;
        for (let page = 0; page <= 40; page += 1) {
          const batch = jmapValue(
            await c.client.calendarEventPage(c.session, c.id, {
              filter: {},
              position: page * 500,
              limit: 500,
            }),
          );
          if (
            (queryState !== undefined &&
              queryState !== batch.query.queryState) ||
            (eventState !== undefined && eventState !== batch.events.state) ||
            batch.events.notFound.length ||
            batch.events.list.length !== batch.query.ids.length
          )
            return fail("unavailable");
          queryState = batch.query.queryState;
          eventState = batch.events.state;
          if (page === 40 && batch.query.ids.length) return fail("unavailable");
          for (const event of batch.events.list) {
            planned.push(
              ...planEvent(
                event,
                calendars,
                from.getTime(),
                until.getTime(),
                user.calendarTimeZone,
              ),
            );
            if (planned.length > 20_000) return fail("unavailable");
          }
          if (batch.query.ids.length < 500) return planned;
        }
        return fail("unavailable");
      });
      if (result.isErr()) throw new Error("Calendar snapshot unavailable");
      return result.value;
    },
  };
}
