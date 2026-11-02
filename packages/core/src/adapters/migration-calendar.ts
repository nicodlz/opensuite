import ICAL from "ical.js";
import { z } from "zod";
import { err, ok, type Result } from "neverthrow";
import {
  calendarImportLimits,
  type CalendarImportFile,
} from "@opensuite/contracts";
import type { CalendarImportRow } from "@opensuite/db";
import { occurrenceKey, stringValue } from "./invitations/common.ts";

const maximumBytes = calendarImportLimits.bytes;
const maximumEvents = calendarImportLimits.events;
const properties: Record<string, string | null> = {
  uid: "uid",
  summary: "title",
  description: "description",
  location: "locations",
  dtstart: "start",
  dtend: "duration",
  duration: "duration",
  rrule: "recurrenceRule",
  exrule: "excludedRecurrenceRules",
  rdate: "recurrenceOverrides",
  exdate: "recurrenceOverrides",
  "recurrence-id": "recurrenceOverrides",
  organizer: "organizerCalendarAddress",
  attendee: "participants",
  url: "links",
  status: "status",
  class: "privacy",
  transparency: "freeBusyStatus",
  sequence: "sequence",
  created: "created",
  "last-modified": "updated",
  dtstamp: null,
};
const bad = (
  file: string,
  error: string,
  uid: string | null = null,
  title = "",
): CalendarImportRow => ({
  file,
  sourceId: file,
  uid,
  title,
  source: "",
  event: null,
  previewState: "invalid",
  previewReason: error,
  issues: "[]",
  state: "failed",
  error,
});

function withoutEmailAlarms(event: ICAL.Component, issues: Set<string>) {
  const copy = new ICAL.Component(structuredClone(event.jCal));
  for (const alarm of copy.getAllSubcomponents("valarm")) {
    const action = stringValue(alarm, "action").toUpperCase();
    if (action !== "DISPLAY") {
      issues.add(`Alarm not imported: ${action || "UNKNOWN"}`);
      copy.removeSubcomponent(alarm);
    }
  }
  return copy;
}
function groupedRow(
  root: ICAL.Component,
  file: string,
  uid: string,
  events: ICAL.Component[],
): CalendarImportRow {
  const first =
    events.find((event) => !event.hasProperty("recurrence-id")) ?? events[0];
  if (!first) return bad(file, "Empty series", uid);
  const title = stringValue(first, "summary");
  try {
    const identities = events.map(occurrenceKey);
    if (
      new Set(identities).size !== identities.length ||
      !identities.includes("master")
    )
      throw new Error("Duplicate occurrence or missing series master");
    const calendar = new ICAL.Component("vcalendar");
    for (const prop of root.getAllProperties())
      calendar.addProperty(new ICAL.Property(structuredClone(prop.jCal)));
    calendar.removeAllProperties("method");
    for (const zone of root.getAllSubcomponents("vtimezone"))
      calendar.addSubcomponent(new ICAL.Component(structuredClone(zone.jCal)));
    const issues = new Set<string>();
    if (root.hasProperty("method"))
      issues.add("Calendar property not imported: METHOD");
    for (const event of events)
      calendar.addSubcomponent(withoutEmailAlarms(event, issues));
    return {
      file,
      sourceId: file,
      uid,
      title,
      source: calendar.toString(),
      event: null,
      previewState: "new",
      previewReason: null,
      issues: JSON.stringify([...issues]),
      state: "pending",
      error: null,
    };
  } catch (error) {
    return bad(
      file,
      error instanceof Error ? error.message : "Invalid event",
      uid,
      title,
    );
  }
}
function fileRows(file: CalendarImportFile): {
  rows: CalendarImportRow[];
  count: number;
} {
  try {
    const root = ICAL.Component.fromString(file.content);
    if (root.name !== "vcalendar") throw new Error("Expected a VCALENDAR");
    const rows: CalendarImportRow[] = root
      .getAllSubcomponents()
      .filter((c) => !["vevent", "vtimezone"].includes(c.name))
      .map((c) =>
        bad(file.name, `Unsupported component: ${c.name.toUpperCase()}`),
      );
    const components = root.getAllSubcomponents("vevent");
    if (components.length > maximumEvents)
      return { rows: [], count: components.length };
    const shared =
      root
        .getAllProperties()
        .reduce(
          (sum, prop) => sum + Buffer.byteLength(prop.toICALString()) + 2,
          64,
        ) +
      root
        .getAllSubcomponents("vtimezone")
        .reduce((sum, zone) => sum + Buffer.byteLength(zone.toString()), 0);
    const eventBytes = components.reduce(
      (sum, event) => sum + Buffer.byteLength(event.toString()),
      0,
    );
    if (
      shared * components.length + eventBytes >
      calendarImportLimits.expandedBytes
    )
      throw new Error("Calendar content exceeds the import limit");
    if (!components.length) rows.push(bad(file.name, "No events found"));
    const groups = new Map<string, ICAL.Component[]>();
    for (const event of components) {
      const uid = stringValue(event, "uid");
      if (!uid || Buffer.byteLength(uid) > 1024 || uid.includes("\0")) {
        rows.push(bad(file.name, "Missing or invalid UID"));
        continue;
      }
      const group = groups.get(uid) ?? [];
      group.push(event);
      groups.set(uid, group);
    }
    for (const [uid, events] of groups)
      rows.push(groupedRow(root, file.name, uid, events));
    return { rows, count: components.length };
  } catch (error) {
    return {
      rows: [
        bad(
          file.name,
          error instanceof Error ? error.message : "Invalid calendar",
        ),
      ],
      count: 0,
    };
  }
}
const invalid = (message: string) =>
  err({ kind: "validation" as const, message });
/** Split one input into complete UID groups using the invitation parser's iCalendar library. */
export function splitCalendars(
  files: CalendarImportFile[],
): Result<CalendarImportRow[], { kind: "validation"; message: string }> {
  if (
    files.some(
      (file) =>
        file.name.includes("\0") ||
        file.content.includes("\0") ||
        file.sourceId?.includes("\0"),
    )
  )
    return invalid("Calendar files contain invalid characters");
  if (
    files.reduce((sum, file) => sum + Buffer.byteLength(file.content), 0) >
    maximumBytes
  )
    return invalid("Calendar files exceed the upload limit");
  const rows: CalendarImportRow[] = [];
  let count = 0;
  let bytes = 0;
  for (const file of files) {
    const parsed = fileRows(file);
    for (const row of parsed.rows) row.sourceId = file.sourceId ?? file.name;
    count += parsed.count;
    if (count > maximumEvents) return invalid("Too many events");
    bytes += parsed.rows.reduce(
      (sum, row) => sum + Buffer.byteLength(row.source),
      0,
    );
    if (
      bytes > calendarImportLimits.expandedBytes ||
      rows.length + parsed.rows.length > maximumEvents
    )
      return invalid("Calendar content exceeds the import limit");
    rows.push(...parsed.rows);
  }
  return ok(rows);
}

function componentIssues(
  component: ICAL.Component,
  event: Record<string, unknown>,
  issues: Set<string>,
) {
  for (const child of component.getAllSubcomponents()) {
    if (child.name !== "valarm" || (event["alerts"] ?? null) === null)
      issues.add(`Component may not be preserved: ${child.name.toUpperCase()}`);
    else
      for (const property of child.getAllProperties()) {
        const name = property.name.toUpperCase();
        if (name) issues.add(`Alarm property requires verification: ${name}`);
      }
  }
}

function eventIssues(
  component: ICAL.Component,
  event: Record<string, unknown>,
  issues: Set<string>,
) {
  for (const property of component.getAllProperties()) {
    const name = property.name;
    const mapped = properties[name];
    if (component.hasProperty("recurrence-id"))
      issues.add(`Verify exception property: ${name.toUpperCase()}`);
    const tzid = property.getFirstParameter("tzid");
    if (
      name === "dtstart" &&
      typeof tzid === "string" &&
      event["timeZone"] !== tzid
    )
      issues.add(`Time zone may not be preserved: ${tzid}`);
    if (
      [
        "rrule",
        "exrule",
        "rdate",
        "exdate",
        "recurrence-id",
        "attendee",
        "organizer",
      ].includes(name)
    )
      issues.add(`Verify converted property: ${name.toUpperCase()}`);
    if (typeof mapped !== "string" || (event[mapped] ?? null) === null)
      issues.add(`Property may not be preserved: ${name.toUpperCase()}`);
    const parameters: unknown = property.jCal[1];
    if (
      Object.keys(z.record(z.string(), z.unknown()).parse(parameters)).some(
        (key) =>
          !["tzid", "value", "cn", "partstat", "role", "rsvp"].includes(key),
      )
    )
      issues.add(
        `Property parameters require verification: ${name.toUpperCase()}`,
      );
  }
  componentIssues(component, event, issues);
}

/** Report fields Stalwart did not expose and fields whose fidelity cannot be established. */
export function calendarIssues(
  source: string,
  event: Record<string, unknown>,
): string[] {
  const root = ICAL.Component.fromString(source);
  const issues = new Set<string>();
  for (const property of root.getAllProperties())
    if (!["version", "prodid"].includes(property.name))
      issues.add(
        `Calendar property may not be preserved: ${property.name.toUpperCase()}`,
      );
  for (const component of root.getAllSubcomponents()) {
    if (component.name === "vtimezone") {
      issues.add(
        "Custom time-zone definition may not be preserved; verify converted time zone",
      );
      continue;
    }
    if (component.name !== "vevent") {
      issues.add(`Unsupported component: ${component.name.toUpperCase()}`);
      continue;
    }
    eventIssues(component, event, issues);
  }
  return [...issues].toSorted();
}

const issuesSchema = z.array(z.string());
const omitted = new Set([
  "id",
  "baseEventId",
  "calendarIds",
  "isDraft",
  "isOrigin",
  "method",
  "version",
]);
export function applyParsed(
  row: CalendarImportRow,
  parsed: Record<string, unknown>[] | undefined,
): Result<void, { kind: "unavailable" }> {
  if (
    !parsed ||
    parsed.length !== 1 ||
    !parsed[0] ||
    parsed[0]["uid"] !== row.uid
  ) {
    row.state = "failed";
    row.previewState = "invalid";
    row.previewReason = "Calendar server could not parse this series";
    row.error = "Calendar server could not parse this series";
    return ok(undefined);
  }
  try {
    const event = Object.fromEntries(
      Object.entries(parsed[0]).filter(([key]) => !omitted.has(key)),
    );
    const issues = [
      ...new Set([
        ...issuesSchema.parse(JSON.parse(row.issues)),
        ...calendarIssues(row.source, event),
      ]),
    ];
    row.event = JSON.stringify(event);
    row.issues = JSON.stringify(issues);
    return ok(undefined);
  } catch {
    return err({ kind: "unavailable" });
  }
}
