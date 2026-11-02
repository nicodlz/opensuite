import type ICAL from "ical.js";
import { copyProperty } from "./common.ts";

const localFields = [
  ["summary"],
  ["description"],
  ["location"],
  ["dtstart", "dtend", "duration"],
  ["rrule"],
  ["status"],
];

function properties(event: ICAL.Component, names: readonly string[]) {
  return JSON.stringify(
    names.map((name) =>
      event
        .getAllProperties(name)
        .map((property) => property.toICALString())
        .toSorted(),
    ),
  );
}

/** Keep local fields when this organizer revision did not change them. */
export function preserveLocalFields(
  replacement: ICAL.Component,
  source: ICAL.Component,
  reference: ICAL.Component | undefined,
) {
  if (!reference) return;
  for (const names of localFields) {
    if (properties(replacement, names) !== properties(reference, names))
      continue;
    for (const name of names) {
      replacement.removeAllProperties(name);
      for (const property of source.getAllProperties(name))
        replacement.addProperty(copyProperty(property));
    }
  }
}
