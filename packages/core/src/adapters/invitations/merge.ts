import ICAL from "ical.js";
import type {
  ParsedInvitation,
  Participation,
} from "../../domain/invitations/types.ts";
import {
  attendeeFor,
  copyComponent,
  copyProperty,
  mailbox,
  occurrenceKey,
  sequenceOf,
  stringValue,
  time,
} from "./common.ts";
import { preserveLocalFields } from "./local-changes.ts";

const exposed = new Set([
  "uid",
  "recurrence-id",
  "sequence",
  "dtstamp",
  "last-modified",
  "dtstart",
  "dtend",
  "duration",
  "summary",
  "description",
  "location",
  "rrule",
  "organizer",
  "attendee",
  "status",
]);

const comparable = (
  event: ICAL.Component,
  recipient: string,
  incoming?: ICAL.Component,
) => {
  const clone = copyComponent(event);
  if (incoming) {
    const supplied = new Set(
      incoming.getAllProperties().map((property) => property.name),
    );
    const removed = new Set(
      clone
        .getAllProperties()
        .map((property) => property.name)
        .filter((name) => !exposed.has(name) && !supplied.has(name)),
    );
    for (const name of removed) clone.removeAllProperties(name);
    if (!incoming.getAllSubcomponents("valarm").length)
      clone.removeAllSubcomponents("valarm");
  }
  clone.removeAllProperties("dtstamp");
  clone.removeAllProperties("last-modified");
  for (const attendee of clone.getAllProperties("attendee"))
    if (mailbox(attendee.getFirstValue()) === recipient.toLowerCase()) {
      attendee.removeParameter("partstat");
      attendee.removeParameter("rsvp");
    }
  return JSON.stringify({
    properties: clone
      .getAllProperties()
      .map((p) => p.toICALString())
      .toSorted(),
    components: clone
      .getAllSubcomponents()
      .map((c) => c.toString())
      .toSorted(),
  });
};

function cancelledEvent(
  prior: ICAL.Component,
  update: ICAL.Component,
  exists: boolean,
) {
  const replacement = copyComponent(prior);
  if (!exists) {
    replacement.removeAllProperties("rrule");
    replacement.removeAllProperties("exdate");
    const recurrence = update.getFirstProperty("recurrence-id");
    if (!recurrence) throw new Error("Invalid recurrence ID");
    replacement.addProperty(copyProperty(recurrence));
    const start = replacement.getFirstProperty("dtstart");
    const end = replacement.getFirstProperty("dtend");
    const oldStart = start?.getFirstValue();
    const oldEnd = end?.getFirstValue();
    const nextStart = recurrence.getFirstValue();
    if (start && nextStart instanceof ICAL.Time) {
      if (end && oldStart instanceof ICAL.Time && oldEnd instanceof ICAL.Time) {
        const nextEnd = nextStart.clone();
        nextEnd.addDuration(oldEnd.subtractDate(oldStart));
        end.setValue(nextEnd);
      }
      start.setValue(nextStart);
    }
  }
  replacement.updatePropertyWithValue("sequence", sequenceOf(update));
  const stamp = update.getFirstPropertyValue("dtstamp");
  if (stamp instanceof ICAL.Time)
    replacement.updatePropertyWithValue("dtstamp", stamp.clone());
  replacement.updatePropertyWithValue("status", "CANCELLED");
  return replacement;
}

function updatedEvent(
  update: ICAL.Component,
  source: ICAL.Component | undefined,
  exists: boolean,
  recipient: string,
  reference: ICAL.Component | undefined,
) {
  const replacement = copyComponent(update);
  if (!source) return replacement;
  preserveLocalFields(replacement, source, reference);
  const oldAttendee = attendeeFor(source, recipient);
  const newAttendee = attendeeFor(replacement, recipient);
  const partstat = oldAttendee.getFirstParameter("partstat");
  if (partstat) newAttendee.setParameter("partstat", partstat);
  const rsvp = oldAttendee.getFirstParameter("rsvp");
  if (rsvp) newAttendee.setParameter("rsvp", rsvp);
  else newAttendee.removeParameter("rsvp");
  const supplied = new Set(
    replacement.getAllProperties().map((property) => property.name),
  );
  for (const property of source.getAllProperties())
    if (
      !exposed.has(property.name) &&
      !supplied.has(property.name) &&
      (exists || !["rdate", "exdate"].includes(property.name))
    )
      replacement.addProperty(copyProperty(property));
  if (!replacement.getAllSubcomponents("valarm").length)
    for (const alarm of source.getAllSubcomponents("valarm"))
      replacement.addSubcomponent(copyComponent(alarm));
  return replacement;
}

function revisionAlreadyApplied(
  existing: ICAL.Component,
  update: ICAL.Component,
  method: ParsedInvitation["method"],
  recipient: string,
): boolean {
  const nextSequence = sequenceOf(update);
  const oldSequence = sequenceOf(existing);
  if (nextSequence < oldSequence) throw new Error("Stale invitation");
  if (nextSequence === oldSequence) {
    if (method === "CANCEL") {
      if (stringValue(existing, "status").toUpperCase() === "CANCELLED")
        return true;
    } else {
      const unchanged =
        comparable(existing, recipient, update) ===
        comparable(update, recipient);
      const oldStamp = existing.getFirstPropertyValue("dtstamp");
      const nextStamp = update.getFirstPropertyValue("dtstamp");
      if (
        !(oldStamp instanceof ICAL.Time) ||
        !(nextStamp instanceof ICAL.Time)
      ) {
        if (unchanged) return true;
        throw new Error("Conflicting invitation");
      }
      const order = nextStamp.compare(oldStamp);
      if (order < 0) throw new Error("Stale invitation");
      if (order === 0 && !unchanged) throw new Error("Conflicting invitation");
      return order === 0;
    }
  }
  return false;
}

function checkIdentity(
  hasPrevious: boolean,
  master: ICAL.Component | undefined,
  update: ICAL.Component,
) {
  if (
    hasPrevious &&
    (!master ||
      stringValue(master, "uid") !== stringValue(update, "uid") ||
      master.getAllProperties("organizer").length !== 1 ||
      mailbox(master.getFirstPropertyValue("organizer")) !==
        mailbox(update.getFirstPropertyValue("organizer")))
  )
    throw new Error("Conflicting organizer or UID");
}

function eventAt(events: ICAL.Component[] | undefined, identity: string) {
  return events?.find((event) => occurrenceKey(event) === identity);
}

function resolveUpdate(
  root: ICAL.Component,
  update: ICAL.Component,
  hasPrevious: boolean,
  method: ParsedInvitation["method"],
  referenceEvents?: ICAL.Component[],
) {
  const identity = occurrenceKey(update);
  const existingEvents = root.getAllSubcomponents("vevent");
  const existing = eventAt(existingEvents, identity);
  const master = eventAt(existingEvents, "master");
  const reference = eventAt(referenceEvents, identity);
  const referenceMaster = eventAt(referenceEvents, "master");
  const revision = referenceEvents ? reference : existing;
  const prior = existing ?? (method === "CANCEL" ? master : undefined);
  checkIdentity(hasPrevious, master, update);
  if (method === "CANCEL" && !prior) throw new Error("Unknown event");
  const comparisonMaster = referenceMaster ?? master;
  if (
    !revision &&
    comparisonMaster &&
    sequenceOf(update) < sequenceOf(comparisonMaster)
  )
    throw new Error("Stale invitation");
  if (
    referenceEvents &&
    !reference &&
    existing &&
    sequenceOf(update) <= sequenceOf(existing)
  )
    throw new Error("Conflicting local occurrence");
  return { existing, master, reference, referenceMaster, revision, prior };
}

function applyUpdate(
  root: ICAL.Component,
  update: ICAL.Component,
  hasPrevious: boolean,
  method: ParsedInvitation["method"],
  recipient: string,
  referenceEvents?: ICAL.Component[],
) {
  const { existing, master, reference, referenceMaster, revision, prior } =
    resolveUpdate(root, update, hasPrevious, method, referenceEvents);
  if (revision && revisionAlreadyApplied(revision, update, method, recipient))
    return;
  const replacement =
    method === "CANCEL" && prior
      ? cancelledEvent(prior, update, existing !== undefined)
      : updatedEvent(
          update,
          existing ?? master,
          existing !== undefined,
          recipient,
          reference ?? referenceMaster,
        );
  if (existing) root.removeSubcomponent(existing);
  root.addSubcomponent(replacement);
}

function applyResponse(
  root: ICAL.Component,
  previous: string | null,
  recipient: string,
  response:
    { participation: Participation; recurrenceId: string | null } | undefined,
) {
  if (response) {
    const candidates = root
      .getAllSubcomponents("vevent")
      .filter(
        (event) => time(event, "recurrence-id") === response.recurrenceId,
      );
    if (candidates.length !== 1 || !candidates[0])
      throw new Error("Invalid occurrence");
    const targets =
      response.recurrenceId === null && previous === null
        ? root.getAllSubcomponents("vevent")
        : candidates;
    for (const target of targets) {
      const attendee = attendeeFor(target, recipient);
      attendee.setParameter("partstat", response.participation);
      attendee.removeParameter("rsvp");
    }
  }
}

function cancelSeriesExceptions(root: ICAL.Component, update: ICAL.Component) {
  for (const event of root.getAllSubcomponents("vevent")) {
    if (occurrenceKey(event) === "master") continue;
    event.updatePropertyWithValue(
      "sequence",
      Math.max(sequenceOf(event), sequenceOf(update)),
    );
    const stamp = update.getFirstPropertyValue("dtstamp");
    if (stamp instanceof ICAL.Time)
      event.updatePropertyWithValue("dtstamp", stamp.clone());
    event.updatePropertyWithValue("status", "CANCELLED");
  }
}

/** Merge organizer revisions by UID and recurrence ID, keeping local participation. */
export function mergeInvitationCalendar(
  previous: string | null,
  incoming: ParsedInvitation,
  recipient: string,
  response?: { participation: Participation; recurrenceId: string | null },
  organizerPrevious?: string | null,
): string {
  if (previous === null && incoming.method === "CANCEL")
    throw new Error("Unknown event");
  const incomingRoot = ICAL.Component.fromString(incoming.calendar);
  const root = previous
    ? ICAL.Component.fromString(previous)
    : new ICAL.Component("vcalendar");
  const referenceEvents = organizerPrevious
    ? ICAL.Component.fromString(organizerPrevious).getAllSubcomponents("vevent")
    : undefined;
  if (!previous) {
    for (const property of incomingRoot.getAllProperties())
      if (property.name !== "method") root.addProperty(copyProperty(property));
  }
  root.removeAllProperties("method");
  for (const zone of incomingRoot.getAllSubcomponents("vtimezone")) {
    const id = stringValue(zone, "tzid");
    if (
      !root
        .getAllSubcomponents("vtimezone")
        .some((existing) => stringValue(existing, "tzid") === id)
    )
      root.addSubcomponent(copyComponent(zone));
  }
  const incomingEvents = incomingRoot.getAllSubcomponents("vevent");
  const keys = incomingEvents.map(occurrenceKey);
  if (new Set(keys).size !== keys.length)
    throw new Error("Duplicate recurrence ID");
  for (const update of incomingEvents) {
    applyUpdate(
      root,
      update,
      previous !== null,
      incoming.method,
      recipient,
      referenceEvents,
    );
    if (incoming.method === "CANCEL" && occurrenceKey(update) === "master")
      cancelSeriesExceptions(root, update);
  }
  if (
    !root
      .getAllSubcomponents("vevent")
      .some((event) => occurrenceKey(event) === "master")
  )
    throw new Error("Missing recurring master");
  applyResponse(root, previous, recipient, response);
  return root.toString();
}
