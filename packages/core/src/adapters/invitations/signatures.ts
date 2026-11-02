import ICAL from "ical.js";
import {
  copyComponent,
  occurrenceKey,
  sequenceOf,
  stringValue,
} from "./common.ts";

function signature(event: ICAL.Component, ignored: readonly string[] = []) {
  const clone = copyComponent(event);
  for (const name of [
    "created",
    "last-modified",
    "dtstamp",
    "sequence",
    ...ignored,
  ])
    clone.removeAllProperties(name);
  return {
    sequence: sequenceOf(event),
    properties: clone
      .getAllProperties()
      .map((property) => property.toICALString())
      .toSorted(),
    components: clone
      .getAllSubcomponents()
      .map((component) => component.toString())
      .toSorted(),
  };
}

// Some CalDAV servers omit an unmodified occurrence when its entire series is
// cancelled. Treat only that redundant representation as equivalent.
function redundantCancellation(master: ICAL.Component, event: ICAL.Component) {
  if (
    stringValue(master, "status").toUpperCase() !== "CANCELLED" ||
    stringValue(event, "status").toUpperCase() !== "CANCELLED"
  )
    return false;
  const recurrence = event.getFirstPropertyValue("recurrence-id");
  const start = event.getFirstPropertyValue("dtstart");
  const end = event.getFirstPropertyValue("dtend");
  const masterStart = master.getFirstPropertyValue("dtstart");
  const masterEnd = master.getFirstPropertyValue("dtend");
  if (
    !(recurrence instanceof ICAL.Time) ||
    !(start instanceof ICAL.Time) ||
    !(end instanceof ICAL.Time) ||
    !(masterStart instanceof ICAL.Time) ||
    !(masterEnd instanceof ICAL.Time) ||
    start.compare(recurrence) !== 0 ||
    end.subtractDate(start).toSeconds() !==
      masterEnd.subtractDate(masterStart).toSeconds()
  )
    return false;
  const ignored = [
    "recurrence-id",
    "dtstart",
    "dtend",
    "rrule",
    "rdate",
    "exdate",
  ];
  return (
    JSON.stringify(signature(master, ignored)) ===
    JSON.stringify(signature(event, ignored))
  );
}

/** Compare event content while allowing server timestamps and redundant cancellations. */
export function calendarSignature(calendar: string): string {
  const events =
    ICAL.Component.fromString(calendar).getAllSubcomponents("vevent");
  const master = events.find((event) => occurrenceKey(event) === "master");
  return JSON.stringify(
    events
      .filter(
        (event) =>
          !master || event === master || !redundantCancellation(master, event),
      )
      .map((event) =>
        Object.assign({ occurrence: occurrenceKey(event) }, signature(event)),
      )
      .toSorted((a, b) => a.occurrence.localeCompare(b.occurrence)),
  );
}
