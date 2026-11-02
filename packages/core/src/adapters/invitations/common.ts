import ICAL from "ical.js";
import { z } from "zod";
import {
  isTimeZone,
  parseLocal,
  toInstant,
} from "../../domain/invitations/time.ts";

export const addressSchema = z.email().max(320);
export const text = (value: unknown) =>
  typeof value === "string" ? value : "";
export const stringValue = (component: ICAL.Component, name: string) =>
  text(component.getFirstPropertyValue(name));
export const mailbox = (value: unknown) => {
  const uri = text(value);
  if (!/^mailto:/i.test(uri)) return undefined;
  const candidate = uri.slice(7);
  const parsed = addressSchema.safeParse(candidate);
  return parsed.success ? parsed.data.toLowerCase() : undefined;
};
export const time = (event: ICAL.Component, name: string) => {
  const value = event.getFirstPropertyValue(name);
  return value instanceof ICAL.Time ? value.toString() : null;
};

export const copyProperty = (property: ICAL.Property) =>
  new ICAL.Property(structuredClone(property.jCal));
export const copyComponent = (component: ICAL.Component) =>
  new ICAL.Component(structuredClone(component.jCal));
export const attendeeFor = (event: ICAL.Component, recipient: string) => {
  const matches = event
    .getAllProperties("attendee")
    .filter(
      (property) =>
        mailbox(property.getFirstValue()) === recipient.toLowerCase(),
    );
  if (matches.length !== 1 || !matches[0]) throw new Error("Invalid recipient");
  return matches[0];
};

export const occurrenceKey = (event: ICAL.Component) => {
  const property = event.getFirstProperty("recurrence-id");
  if (!property) return "master";
  if (property.getFirstParameter("range"))
    throw new Error("Unsupported recurrence range");
  const value = property.getFirstValue();
  if (!(value instanceof ICAL.Time)) throw new Error("Invalid recurrence ID");
  if (value.isDate) return `date:${value.toString()}`;
  const zone = property.getFirstParameter("tzid");
  if (value.zone.tzid !== "floating")
    return `instant:${String(value.toUnixTime() * 1000)}`;
  if (zone) {
    const wall = parseLocal(value.toString(), zone);
    if (wall === undefined || !isTimeZone(zone))
      throw new Error("Unknown recurrence time zone");
    return `instant:${String(toInstant(wall, zone))}`;
  }
  return `floating:${value.toString()}`;
};
export const sequenceOf = (event: ICAL.Component) => {
  const raw: unknown = event.getFirstPropertyValue("sequence");
  const sequence = raw === null ? 0 : Number(raw);
  if (!Number.isSafeInteger(sequence) || sequence < 0)
    throw new Error("Invalid sequence");
  return sequence;
};
