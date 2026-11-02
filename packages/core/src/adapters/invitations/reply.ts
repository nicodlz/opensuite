import ICAL from "ical.js";
import type { Participation } from "../../domain/invitations/types.ts";
import { attendeeFor, copyComponent, copyProperty, time } from "./common.ts";

/** Construct a REPLY with only the responding attendee and the original organizer. */
export function createInvitationReply(
  calendar: string,
  recipient: string,
  participation: Participation,
  recurrenceId: string | null,
  now: Date,
): string {
  const original = ICAL.Component.fromString(calendar);
  const candidates = original
    .getAllSubcomponents("vevent")
    .filter((event) => time(event, "recurrence-id") === recurrenceId);
  if (candidates.length !== 1 || !candidates[0])
    throw new Error("Invalid occurrence");
  const event = candidates[0];
  const reply = new ICAL.Component("vcalendar");
  reply.addPropertyWithValue("prodid", "-//Esuno//Calendar//EN");
  reply.addPropertyWithValue("version", "2.0");
  reply.addPropertyWithValue("method", "REPLY");
  for (const zone of original.getAllSubcomponents("vtimezone"))
    reply.addSubcomponent(copyComponent(zone));
  const response = new ICAL.Component("vevent");
  for (const name of [
    "uid",
    "recurrence-id",
    "dtstart",
    "dtend",
    "sequence",
    "organizer",
  ]) {
    const property = event.getFirstProperty(name);
    if (property) response.addProperty(copyProperty(property));
  }
  if (!response.hasProperty("uid") || !response.hasProperty("organizer"))
    throw new Error("Invalid invitation identity");
  response.addPropertyWithValue("dtstamp", ICAL.Time.fromJSDate(now, true));
  const attendee = copyProperty(attendeeFor(event, recipient));
  attendee.setParameter("partstat", participation);
  attendee.removeParameter("rsvp");
  response.addProperty(attendee);
  reply.addSubcomponent(response);
  return reply.toString();
}
