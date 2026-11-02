import ICAL from "ical.js";
import {
  copyProperty,
  mailbox,
  occurrenceKey,
  sequenceOf,
  stringValue,
} from "./common.ts";

type Identity = {
  occurrence: string;
  sequence: number;
  people: string[];
  schedule: string[];
};
const scheduleFields = new Set([
  "dtstart",
  "dtend",
  "duration",
  "rrule",
  "rdate",
  "exdate",
  "recurrence-id",
  "status",
]);
function identities(
  calendar: string,
  uid: string,
  organizer: string,
): Identity[] {
  const root = ICAL.Component.fromString(calendar);
  const events = root.getAllSubcomponents("vevent");
  if (!events.length || events.length > 100) throw new Error("Invalid series");
  const result = events
    .map((event) => {
      if (
        event.getAllProperties("uid").length !== 1 ||
        stringValue(event, "uid") !== uid ||
        event.getAllProperties("organizer").length !== 1 ||
        mailbox(event.getFirstPropertyValue("organizer")) !== organizer
      )
        throw new Error("Invalid series identity");
      const people = event
        .getAllProperties("attendee")
        .map((property) => {
          const address = mailbox(property.getFirstValue());
          if (!address) throw new Error("Invalid attendee");
          return `${address}:${(property.getFirstParameter("partstat") || "NEEDS-ACTION").toUpperCase()}`;
        })
        .toSorted();
      if (
        new Set(people.map((person) => person.split(":")[0])).size !==
        people.length
      )
        throw new Error("Duplicate attendee");
      const schedule = event
        .getAllProperties()
        .filter((property) => scheduleFields.has(property.name))
        .map((property) => property.toICALString())
        .toSorted();
      return {
        occurrence: occurrenceKey(event),
        sequence: sequenceOf(event),
        people,
        schedule,
      };
    })
    .toSorted((a, b) => a.occurrence.localeCompare(b.occurrence));
  if (
    !result.some((event) => event.occurrence === "master") ||
    new Set(result.map((event) => event.occurrence)).size !== result.length
  )
    throw new Error("Invalid occurrences");
  return result;
}
/** Rebase only owner edits that cannot substitute an organizer or attendee response. */
export function rebaseOrganized(
  previous: string,
  current: string,
  uid: string,
  organizer: string,
  allowScheduleChanges: boolean,
) {
  const before = identities(previous, uid, organizer);
  const after = identities(current, uid, organizer);
  if (allowScheduleChanges)
    return Math.max(
      ...before.map((event) => event.sequence),
      ...after.map((event) => event.sequence),
    );
  if (before.length !== after.length) throw new Error("Changed occurrences");
  for (const [index, next] of after.entries()) {
    const prior = before[index];
    if (
      !prior ||
      prior.occurrence !== next.occurrence ||
      next.sequence < prior.sequence ||
      JSON.stringify(prior.people) !== JSON.stringify(next.people) ||
      JSON.stringify(prior.schedule) !== JSON.stringify(next.schedule)
    )
      throw new Error("Conflicting series edit");
  }
  return Math.max(...after.map((event) => event.sequence));
}

export function organizerFields(calendar: string) {
  const root = ICAL.Component.fromString(calendar);
  const masters = root
    .getAllSubcomponents("vevent")
    .filter((event) => !event.hasProperty("recurrence-id"));
  if (masters.length !== 1 || !masters[0])
    throw new Error("Invalid event series");
  return {
    title: stringValue(masters[0], "summary"),
    description: stringValue(masters[0], "description"),
    location: stringValue(masters[0], "location"),
  };
}

/** Keep locally edited event fields but derive participants only from the last trusted revision. */
export function restoreOrganizerParticipants(
  previous: string,
  current: string,
) {
  const old = ICAL.Component.fromString(previous).getAllSubcomponents("vevent");
  const root = ICAL.Component.fromString(current);
  const master = old.find((event) => occurrenceKey(event) === "master");
  if (!master) throw new Error("Missing master");
  for (const event of root.getAllSubcomponents("vevent")) {
    const reference =
      old.find((item) => occurrenceKey(item) === occurrenceKey(event)) ??
      master;
    event.removeAllProperties("attendee");
    for (const attendee of reference.getAllProperties("attendee"))
      event.addProperty(copyProperty(attendee));
  }
  return root.toString();
}
