import type { CalendarEvent } from "@opensuite/contracts";
import { ORPCError } from "@orpc/client";
import { accountId, calendarClient } from "./client.ts";
import { formatEventRange, recurrenceLabels, type DateRange } from "./model.ts";

const baseKey = ["calendar", accountId];
/** Every loaded range shares this prefix, so changes update all of them. */
export const eventsKey = [...baseKey, "events"];
export const calendarsKey = [...baseKey, "calendars"];

export type EventsData = { events: CalendarEvent[] };
export type Colors = (calendarId: string) => {
  background: string;
  color: string;
  name: string;
};

export function rangeKey(range: DateRange) {
  return [...eventsKey, range.start.toISOString(), range.end.toISOString()];
}

export function fetchRange(range: DateRange) {
  return () =>
    calendarClient.events({
      accountId,
      start: range.start.toISOString(),
      end: range.end.toISOString(),
    });
}

export function isUnavailable(error: unknown) {
  return error instanceof ORPCError && error.status === 503;
}

export function loadError(error: unknown) {
  if (isUnavailable(error))
    return "Calendar is unavailable. Try again in a moment.";
  return "Your calendar could not be loaded.";
}

export function titleOf(event: { title: string }) {
  return event.title.trim() || "(No title)";
}

/** Accessible name of an event button: title, time, repetition, place, calendar. */
export function eventLabel(event: CalendarEvent, calendarName: string) {
  return [
    titleOf(event),
    formatEventRange(event),
    event.recurrence === "none" ? "" : recurrenceLabels[event.recurrence],
    event.location,
    calendarName,
  ]
    .filter(Boolean)
    .join(", ");
}
