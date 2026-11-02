import ICAL from "ical.js";
import { getVtimezoneComponent } from "@touch4it/ical-timezones";
import type { EventContent } from "@opensuite/contracts";
import { formatLocal, toWall } from "../../domain/invitations/time.ts";
import {
  copyComponent,
  mailbox,
  occurrenceKey,
  sequenceOf,
  stringValue,
} from "./common.ts";

import type { OrganizerEdit } from "../../domain/invitations/organizer.ts";
const eventsOf = (calendar: ICAL.Component) =>
  calendar.getAllSubcomponents("vevent");
const masterOf = (root: ICAL.Component) => {
  const masters = eventsOf(root).filter(
    (event) => !event.hasProperty("recurrence-id"),
  );
  if (masters.length !== 1 || !masters[0])
    throw new Error("Invalid event series");
  return masters[0];
};
export function organizedAttendees(calendar: string) {
  const master = masterOf(ICAL.Component.fromString(calendar));
  const attendees = master.getAllProperties("attendee").map((property) => {
    const email = mailbox(property.getFirstValue());
    if (!email) throw new Error("Invalid attendee");
    return {
      email,
      partstat: (
        property.getFirstParameter("partstat") || "NEEDS-ACTION"
      ).toUpperCase(),
    };
  });
  if (new Set(attendees.map((item) => item.email)).size !== attendees.length)
    throw new Error("Duplicate attendee");
  return attendees;
}
function setTime(
  event: ICAL.Component,
  name: string,
  instant: string,
  content: EventContent,
) {
  const wall = content.allDay
    ? Date.parse(instant)
    : toWall(Date.parse(instant), content.timeZone);
  const local = formatLocal(wall);
  const property = new ICAL.Property(name);
  if (content.allDay)
    property.setValue(ICAL.Time.fromDateString(local.slice(0, 10)));
  else if (content.timeZone === "UTC")
    property.setValue(ICAL.Time.fromJSDate(new Date(instant), true));
  else {
    property.setParameter("tzid", content.timeZone);
    property.setValue(ICAL.Time.fromDateTimeString(local, property));
  }
  event.removeAllProperties(name);
  event.addProperty(property);
}
function applyContent(master: ICAL.Component, input: OrganizerEdit) {
  const { event, changes } = input;
  if (changes.title) master.updatePropertyWithValue("summary", event.title);
  if (changes.description)
    master.updatePropertyWithValue("description", event.description);
  if (changes.location)
    master.updatePropertyWithValue("location", event.location);
  if (changes.time) {
    setTime(master, "dtstart", event.start, event);
    setTime(master, "dtend", event.end, event);
    master.removeAllProperties("duration");
  }
  if (changes.recurrence) {
    master.removeAllProperties("rrule");
    if (event.recurrence !== "none")
      master.addPropertyWithValue(
        "rrule",
        ICAL.Recur.fromString(`FREQ=${event.recurrence.toUpperCase()}`),
      );
  }
}
function applyAttendees(
  event: ICAL.Component,
  desired: string[],
  organizer: string,
  reset: boolean,
) {
  const found = new Set<string>();
  for (const property of event.getAllProperties("attendee").slice()) {
    const address = mailbox(property.getFirstValue());
    if (!address || found.has(address)) throw new Error("Invalid attendee");
    found.add(address);
    if (!desired.includes(address)) event.removeProperty(property);
    else if (reset && address !== organizer) {
      property.setParameter("partstat", "NEEDS-ACTION");
      property.setParameter("rsvp", "TRUE");
    }
  }
  for (const address of desired) {
    if (!found.has(address)) {
      const attendee = new ICAL.Property("attendee");
      attendee.setValue(`mailto:${address}`);
      attendee.setParameter(
        "partstat",
        address === organizer ? "ACCEPTED" : "NEEDS-ACTION",
      );
      if (address !== organizer) attendee.setParameter("rsvp", "TRUE");
      event.addProperty(attendee);
    }
  }
}
function applyExceptionAttendees(
  event: ICAL.Component,
  before: string[],
  after: string[],
  organizer: string,
  reset: boolean,
) {
  const beforeSet = new Set(before);
  const afterSet = new Set(after);
  const removed = new Set(before.filter((address) => !afterSet.has(address)));
  const added = after.filter((address) => !beforeSet.has(address));
  const current = event.getAllProperties("attendee").map((property) => {
    const address = mailbox(property.getFirstValue());
    if (!address) throw new Error("Invalid attendee");
    return address;
  });
  if (new Set(current).size !== current.length)
    throw new Error("Duplicate attendee");
  applyAttendees(
    event,
    [
      ...current.filter((address) => !removed.has(address)),
      ...added.filter((address) => !current.includes(address)),
    ],
    organizer,
    reset,
  );
}
const sharedEventProperties = new Set([
  "uid",
  "sequence",
  "dtstamp",
  "dtstart",
  "dtend",
  "duration",
  "recurrence-id",
  "rrule",
  "rdate",
  "exdate",
  "organizer",
  "attendee",
  "summary",
  "description",
  "location",
  "status",
  "url",
  "conference",
  "transp",
  "priority",
  "class",
]);
function removePrivateData(calendar: ICAL.Component) {
  for (const property of calendar.getAllProperties().slice())
    if (!["version", "prodid", "calscale", "method"].includes(property.name))
      calendar.removeProperty(property);
  for (const component of calendar.getAllSubcomponents().slice())
    if (component.name !== "vevent" && component.name !== "vtimezone")
      calendar.removeSubcomponent(component);
  for (const event of eventsOf(calendar)) {
    for (const property of event.getAllProperties().slice())
      if (!sharedEventProperties.has(property.name))
        event.removeProperty(property);
    event.removeAllSubcomponents();
  }
}
function message(
  root: ICAL.Component,
  recipient: string,
  method: "REQUEST" | "CANCEL",
  sequence: number,
  now: Date,
) {
  const result = copyComponent(root);
  removePrivateData(result);
  result.updatePropertyWithValue("method", method);
  for (const event of eventsOf(result)) {
    event.updatePropertyWithValue("sequence", sequence);
    event.updatePropertyWithValue("dtstamp", ICAL.Time.fromJSDate(now, true));
    for (const attendee of event.getAllProperties("attendee").slice())
      if (mailbox(attendee.getFirstValue()) !== recipient)
        event.removeProperty(attendee);
    if (method === "CANCEL")
      event.updatePropertyWithValue("status", "CANCELLED");
  }
  return result.toString();
}
function seriesRoot(input: OrganizerEdit) {
  const root = input.previous
    ? ICAL.Component.fromString(input.previous)
    : new ICAL.Component("vcalendar");
  if (!input.previous) {
    root.addPropertyWithValue("version", "2.0");
    root.addPropertyWithValue("prodid", "-//Esuno//Calendar//EN");
    const event = new ICAL.Component("vevent");
    event.addPropertyWithValue("uid", input.uid);
    event.addPropertyWithValue("organizer", `mailto:${input.organizer}`);
    root.addSubcomponent(event);
  }
  root.removeAllProperties("method");
  return root;
}
function reviseEvents(
  root: ICAL.Component,
  master: ICAL.Component,
  input: OrganizerEdit,
  prior: string[],
  desired: string[],
) {
  for (const event of eventsOf(root)) {
    if (
      stringValue(event, "uid") !== input.uid ||
      event.getAllProperties("organizer").length !== 1 ||
      mailbox(event.getFirstPropertyValue("organizer")) !== input.organizer ||
      (input.previous && sequenceOf(event) > input.sequence)
    )
      throw new Error("Invalid series identity");
    event.updatePropertyWithValue("sequence", input.sequence);
    event.updatePropertyWithValue(
      "dtstamp",
      ICAL.Time.fromJSDate(input.now, true),
    );
    if (input.cancelled) event.updatePropertyWithValue("status", "CANCELLED");
    else if (event === master)
      applyAttendees(
        event,
        desired,
        input.organizer,
        input.changes.time || input.changes.recurrence,
      );
    else
      applyExceptionAttendees(
        event,
        prior,
        desired,
        input.organizer,
        input.changes.time || input.changes.recurrence,
      );
  }
}
function addTimezone(root: ICAL.Component, input: OrganizerEdit) {
  if (
    input.cancelled ||
    !input.changes.time ||
    input.event.allDay ||
    input.event.timeZone === "UTC"
  )
    return;
  const zone = input.event.timeZone;
  if (
    root
      .getAllSubcomponents("vtimezone")
      .some((part) => stringValue(part, "tzid") === zone)
  )
    return;
  const definition = getVtimezoneComponent(zone);
  if (!definition) throw new Error("Unsupported timezone");
  root.addSubcomponent(ICAL.Component.fromString(definition));
}
/** Preserve the original components and create one isolated iTIP body per recipient. */
export function prepareOrganizedCalendar(input: OrganizerEdit) {
  const root = seriesRoot(input);
  const master = masterOf(root);
  const prior = input.previous
    ? organizedAttendees(input.previous).map((item) => item.email)
    : [];
  const desired = [
    ...new Set(input.attendees.map((value) => value.toLowerCase())),
  ];
  if (desired.length !== input.attendees.length)
    throw new Error("Invalid attendees");
  const original = copyComponent(root);
  reviseEvents(root, master, input, prior, desired);
  addTimezone(root, input);
  if (!input.cancelled) applyContent(master, input);
  const removed = input.cancelled
    ? prior
    : prior.filter((address) => !desired.includes(address));
  const deliveries = [
    ...(input.cancelled
      ? []
      : desired
          .filter((recipient) => recipient !== input.organizer)
          .map((recipient) => ({
            recipient,
            method: "REQUEST" as const,
            calendar: message(
              root,
              recipient,
              "REQUEST",
              input.sequence,
              input.now,
            ),
          }))),
    ...removed
      .filter((recipient) => recipient !== input.organizer)
      .map((recipient) => ({
        recipient,
        method: "CANCEL" as const,
        calendar: message(
          original,
          recipient,
          "CANCEL",
          input.sequence,
          input.now,
        ),
      })),
  ];
  return { calendar: root.toString(), deliveries };
}

/** Match an instance against the series, including generated occurrences. */
export function hasOrganizedOccurrence(calendar: string, occurrence: string) {
  if (occurrence === "master") return true;
  const root = ICAL.Component.fromString(calendar);
  const exception = eventsOf(root).find(
    (item) => occurrenceKey(item) === occurrence,
  );
  if (exception)
    return stringValue(exception, "status").toUpperCase() !== "CANCELLED";
  const master = masterOf(root);
  if (!master.hasProperty("rrule") && !master.hasProperty("rdate"))
    return false;
  return findGeneratedOccurrence(master, occurrence);
}
function targetOf(occurrence: string) {
  if (occurrence.startsWith("instant:"))
    return { instant: Number(occurrence.slice(8)), text: undefined };
  if (occurrence.startsWith("date:"))
    return { instant: NaN, text: occurrence.slice(5) };
  if (occurrence.startsWith("floating:"))
    return { instant: NaN, text: occurrence.slice(9) };
  return { instant: NaN, text: undefined };
}
function findGeneratedOccurrence(master: ICAL.Component, occurrence: string) {
  const { instant: target, text: targetText } = targetOf(occurrence);
  if (!Number.isFinite(target) && !targetText) return false;
  const iterator = new ICAL.Event(master).iterator();
  const startProperty = master.getFirstProperty("dtstart");
  for (let i = 0; i < 10000; i++) {
    const next: unknown = iterator.next();
    if (!(next instanceof ICAL.Time)) return false;
    const probe = new ICAL.Component("vevent");
    const property = new ICAL.Property("recurrence-id");
    const tzid = startProperty?.getFirstParameter("tzid");
    if (tzid) property.setParameter("tzid", tzid);
    property.setValue(next);
    probe.addProperty(property);
    const key = occurrenceKey(probe);
    if (key === occurrence) return true;
    if (targetText && next.toString() > targetText) return false;
    if (
      Number.isFinite(target) &&
      key.startsWith("instant:") &&
      Number(key.slice(8)) > target
    )
      return false;
  }
  return false;
}
