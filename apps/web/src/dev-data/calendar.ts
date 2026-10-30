import {
  calendarContract,
  type Calendar,
  type CalendarEvent,
  type EventContent,
  type Recurrence,
} from "@opensuite/contracts";
import { createRouterClient, implement } from "@orpc/server";

// Synthetic calendar data lives only in the development bundle. Dates are
// placed relative to the current week so every view has something to show.
const fixtureMarker = "OPENMAIL_SYNTHETIC_FIXTURE_ONLY";
const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const today = new Date();
const monday = new Date(
  today.getFullYear(),
  today.getMonth(),
  today.getDate() - ((today.getDay() + 6) % 7),
);
const at = (day: number, hour: number, minute = 0) =>
  new Date(
    monday.getFullYear(),
    monday.getMonth(),
    monday.getDate() + day,
    hour,
    minute,
  ).toISOString();
const date = (day: number) =>
  new Date(
    Date.UTC(monday.getFullYear(), monday.getMonth(), monday.getDate() + day),
  ).toISOString();

const calendars: Calendar[] = [
  { id: "personal", name: "Personal", color: "#7c5cff", isDefault: true },
  { id: "work", name: "Work", color: "#1f9d8b", isDefault: false },
];
type Series = EventContent & { id: string };
const base = {
  description: "",
  location: "",
  allDay: false,
  timeZone,
  recurrence: "none",
} satisfies Partial<EventContent>;
let series: Series[] = [
  {
    ...base,
    id: "design-review",
    calendarId: "work",
    title: "Design review",
    description: "Walk through the new calendar views.",
    start: at(0, 10),
    end: at(0, 11),
  },
  {
    ...base,
    id: "stand-up",
    calendarId: "work",
    title: "Team stand-up",
    start: at(-12, 9, 30),
    end: at(-12, 9, 45),
    recurrence: "weekly",
  },
  {
    ...base,
    id: "lunch",
    calendarId: "personal",
    title: "Lunch with Sam",
    location: "Café Lumen",
    start: at(1, 12, 30),
    end: at(1, 13, 30),
  },
  {
    ...base,
    id: "conference",
    calendarId: "work",
    title: "Design conference",
    location: "Lyon",
    start: date(2),
    end: date(5),
    allDay: true,
    timeZone: "UTC",
  },
  {
    ...base,
    id: "birthday",
    calendarId: "personal",
    title: "Mia's birthday",
    start: date(3),
    end: date(4),
    allDay: true,
    timeZone: "UTC",
  },
  {
    ...base,
    id: "hiring-panel",
    calendarId: "work",
    title: "Hiring panel",
    start: at(3, 14),
    end: at(3, 15, 30),
  },
  {
    ...base,
    id: "dentist",
    calendarId: "personal",
    title: "Dentist",
    location: "12 Rue des Lilas",
    start: at(3, 15),
    end: at(3, 16),
  },
  {
    ...base,
    id: "run",
    calendarId: "personal",
    title: "Morning run",
    start: at(4, 6),
    end: at(4, 7),
  },
  {
    ...base,
    id: "market",
    calendarId: "personal",
    title: "Weekend market",
    start: at(5, 9),
    end: at(5, 11),
  },
  {
    ...base,
    id: "dinner",
    calendarId: "personal",
    title: "Dinner with friends",
    start: at(-3, 19, 30),
    end: at(-3, 22),
  },
  {
    ...base,
    id: "roadmap",
    calendarId: "work",
    title: "Roadmap workshop",
    start: at(7, 13),
    end: at(7, 15),
  },
];

/** Start of occurrence `index`, or undefined for a skipped invalid date. */
function occurrenceStart(item: Series, index: number) {
  // All-day events are UTC dates; timed events repeat on local wall time.
  const value = new Date(item.start);
  const utc = item.allDay;
  const year = utc ? value.getUTCFullYear() : value.getFullYear();
  const month = utc ? value.getUTCMonth() : value.getMonth();
  const day = utc ? value.getUTCDate() : value.getDate();
  const targets: Record<Recurrence, [number, number, number]> = {
    none: [year, month, day],
    daily: [year, month, day + index],
    weekly: [year, month, day + index * 7],
    monthly: [year, month + index, day],
    yearly: [year + index, month, day],
  };
  const [y, m, d] = targets[item.recurrence];
  if (utc) value.setUTCFullYear(y, m, d);
  else value.setFullYear(y, m, d);
  // Monthly and yearly series skip dates that do not exist (31 April).
  const skipped =
    (item.recurrence === "monthly" || item.recurrence === "yearly") &&
    (utc ? value.getUTCDate() : value.getDate()) !== day;
  return skipped ? undefined : value.getTime();
}
function occurrence(item: Series, index: number): CalendarEvent | undefined {
  const start = occurrenceStart(item, index);
  if (start === undefined) return undefined;
  const length = Date.parse(item.end) - Date.parse(item.start);
  return {
    ...item,
    id: item.recurrence === "none" ? item.id : `${item.id}~${index}`,
    seriesId: item.id,
    start: new Date(start).toISOString(),
    end: new Date(start + length).toISOString(),
  };
}
function occurrences(item: Series, start: number, end: number) {
  const result: CalendarEvent[] = [];
  for (let index = 0; index < 5000; index += 1) {
    const next = occurrence(item, index);
    if (next !== undefined) {
      if (Date.parse(next.start) >= end) break;
      if (Date.parse(next.end) > start) result.push(next);
    }
    if (item.recurrence === "none") break;
  }
  return result;
}
function locate(eventId: string) {
  const [seriesId, index, ...rest] = eventId.split("~");
  const item = series.find((entry) => entry.id === seriesId);
  if (item === undefined || rest.length > 0) return undefined;
  if (index === undefined) return { item, current: occurrence(item, 0) };
  if (!/^\d+$/.test(index) || item.recurrence === "none") return undefined;
  return { item, current: occurrence(item, Number(index)) };
}
const validContent = (content: EventContent) => {
  if (!(Date.parse(content.end) > Date.parse(content.start))) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: content.timeZone }).format();
    return true;
  } catch {
    return content.allDay;
  }
};

const api = implement(calendarContract);
const router = api.router({
  calendars: api.calendars.handler(() => ({ calendars })),
  createCalendar: api.createCalendar.handler(({ input }) => {
    const calendar = {
      id: crypto.randomUUID(),
      name: input.name,
      color: input.color.toLowerCase(),
      isDefault: false,
    };
    calendars.push(calendar);
    return calendar;
  }),
  events: api.events.handler(({ input, errors }) => {
    const start = Date.parse(input.start);
    const end = Date.parse(input.end);
    if (!(end > start)) throw errors.VALIDATION();
    const selected = input.calendarIds;
    if (selected?.some((id) => !calendars.some((item) => item.id === id)))
      throw errors.NOT_FOUND();
    return {
      events: series
        .filter((item) => selected?.includes(item.calendarId) ?? true)
        .flatMap((item) => occurrences(item, start, end))
        .toSorted((a, b) => a.start.localeCompare(b.start)),
    };
  }),
  createEvent: api.createEvent.handler(({ input, errors }) => {
    if (!validContent(input.event)) throw errors.VALIDATION();
    if (!calendars.some((item) => item.id === input.event.calendarId))
      throw errors.NOT_FOUND();
    const item = { ...input.event, id: crypto.randomUUID() };
    series.push(item);
    return occurrence(item, 0) ?? { ...item, seriesId: item.id };
  }),
  updateEvent: api.updateEvent.handler(({ input, errors }) => {
    if (!validContent(input.event)) throw errors.VALIDATION();
    if (!calendars.some((item) => item.id === input.event.calendarId))
      throw errors.NOT_FOUND();
    const found = locate(input.eventId);
    if (found?.current === undefined) throw errors.NOT_FOUND();
    // Updates through an occurrence shift the whole series by the same delta.
    const shift =
      Date.parse(input.event.start) - Date.parse(found.current.start);
    const length = Date.parse(input.event.end) - Date.parse(input.event.start);
    const start = Date.parse(found.item.start) + shift;
    const item = {
      ...input.event,
      id: found.item.id,
      start: new Date(start).toISOString(),
      end: new Date(start + length).toISOString(),
    };
    series = series.map((entry) => (entry.id === item.id ? item : entry));
    return occurrence(item, 0) ?? { ...item, seriesId: item.id };
  }),
  deleteEvent: api.deleteEvent.handler(({ input, errors }) => {
    const found = locate(input.eventId);
    if (found?.current === undefined) throw errors.NOT_FOUND();
    series = series.filter((entry) => entry.id !== found.item.id);
    return { success: true };
  }),
});
export const fakeCalendarClient = createRouterClient(router);
export { fixtureMarker };
