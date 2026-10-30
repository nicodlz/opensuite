import type {
  CalendarEvent,
  EventContent,
  Recurrence,
} from "@opensuite/contracts";

// Date math runs in the browser's local time zone. Grid positions use wall
// clock minutes so 23- and 25-hour days still map to a 24-hour column.

export type CalendarView = "day" | "week" | "month";
export const calendarViews: CalendarView[] = ["day", "week", "month"];
export const MINUTES_PER_DAY = 1440;
const DAY_MS = 86_400_000;

export function isCalendarView(value: unknown): value is CalendarView {
  return value === "day" || value === "week" || value === "month";
}

export function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

/** Calendar-day addition that keeps the wall-clock time across DST. */
export function addDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

export function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/** Whole local days from `from` to `to`, ignoring the time of day. */
export function dayDifference(from: Date, to: Date): number {
  return Math.round(
    (startOfDay(to).getTime() - startOfDay(from).getTime()) / DAY_MS,
  );
}

export function dayKey(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

/** First day of the week as a JavaScript weekday (0 Sunday … 6 Saturday). */
export function firstDayOfWeek(locale?: string): number {
  try {
    const tag = locale ?? new Intl.DateTimeFormat().resolvedOptions().locale;
    const value = new Intl.Locale(tag);
    let info: unknown;
    if ("getWeekInfo" in value && typeof value.getWeekInfo === "function")
      info = Reflect.apply(value.getWeekInfo, value, []);
    else if ("weekInfo" in value) info = value.weekInfo;
    if (
      typeof info === "object" &&
      info !== null &&
      "firstDay" in info &&
      typeof info.firstDay === "number" &&
      info.firstDay >= 1 &&
      info.firstDay <= 7
    )
      return info.firstDay % 7;
  } catch {
    // Older engines without Intl.Locale week data use the European default.
  }
  return 1;
}

export function startOfWeek(date: Date, firstDay: number): Date {
  const day = startOfDay(date);
  return addDays(day, -((day.getDay() - firstDay + 7) % 7));
}

export type DateRange = { start: Date; end: Date };

/** Visible range of a view; `end` is exclusive. Month always shows 6 weeks. */
export function viewRange(
  view: CalendarView,
  anchor: Date,
  firstDay: number,
): DateRange {
  if (view === "day") {
    const start = startOfDay(anchor);
    return { start, end: addDays(start, 1) };
  }
  if (view === "week") {
    const start = startOfWeek(anchor, firstDay);
    return { start, end: addDays(start, 7) };
  }
  const start = startOfWeek(
    new Date(anchor.getFullYear(), anchor.getMonth(), 1),
    firstDay,
  );
  return { start, end: addDays(start, 42) };
}

export function rangeDays(range: DateRange): Date[] {
  const days: Date[] = [];
  for (let day = range.start; day < range.end; day = addDays(day, 1))
    days.push(day);
  return days;
}

export function shiftAnchor(
  view: CalendarView,
  anchor: Date,
  direction: number,
): Date {
  if (view === "day") return addDays(startOfDay(anchor), direction);
  if (view === "week") return addDays(startOfDay(anchor), direction * 7);
  return new Date(anchor.getFullYear(), anchor.getMonth() + direction, 1);
}

/** Local date for an all-day value stored as UTC midnight. */
export function fromAllDay(value: string): Date {
  const date = new Date(value);
  return new Date(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

export function toAllDay(date: Date): string {
  return new Date(
    Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()),
  ).toISOString();
}

type Timing = Pick<CalendarEvent, "start" | "end" | "allDay">;

export function eventStart(event: Timing): Date {
  return event.allDay ? fromAllDay(event.start) : new Date(event.start);
}

export function eventEnd(event: Timing): Date {
  return event.allDay ? fromAllDay(event.end) : new Date(event.end);
}

/** All-day events and timed events of a day or longer use the all-day row. */
export function isSpanning(event: Timing): boolean {
  return (
    event.allDay ||
    eventEnd(event).getTime() - eventStart(event).getTime() >= DAY_MS
  );
}

export function overlapsRange(event: Timing, range: DateRange): boolean {
  const start = eventStart(event);
  const end = eventEnd(event);
  if (end <= start) return start >= range.start && start < range.end;
  return start < range.end && end > range.start;
}

export function wallMinutes(date: Date): number {
  return date.getHours() * 60 + date.getMinutes() + date.getSeconds() / 60;
}

/** Local time `minutes` after the wall-clock midnight of `day`. */
export function dateAtMinutes(day: Date, minutes: number): Date {
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, minutes);
}

export function snapMinutes(minutes: number, step: number): number {
  return Math.min(
    MINUTES_PER_DAY,
    Math.max(0, Math.round(minutes / step) * step),
  );
}

export function floorMinutes(minutes: number, step: number): number {
  return Math.min(
    MINUTES_PER_DAY - step,
    Math.max(0, Math.floor(minutes / step) * step),
  );
}

export type TimedSegment = {
  event: CalendarEvent;
  day: number;
  startMinute: number;
  endMinute: number;
  startsBefore: boolean;
  endsAfter: boolean;
};

/** Timed events split into one segment per visible day they touch. */
export function timedSegments(
  events: CalendarEvent[],
  days: Date[],
): TimedSegment[] {
  const segments: TimedSegment[] = [];
  for (const event of events) {
    if (isSpanning(event)) continue;
    const start = eventStart(event);
    const end = eventEnd(event);
    days.forEach((dayStart, day) => {
      const dayEnd = addDays(dayStart, 1);
      const touches =
        end > start
          ? start < dayEnd && end > dayStart
          : start >= dayStart && start < dayEnd;
      if (!touches) return;
      const startsBefore = start < dayStart;
      const endsAfter = end > dayEnd;
      const startMinute = startsBefore ? 0 : wallMinutes(start);
      const endMinute = end >= dayEnd ? MINUTES_PER_DAY : wallMinutes(end);
      segments.push({
        event,
        day,
        startMinute,
        endMinute: Math.max(startMinute, endMinute),
        startsBefore,
        endsAfter,
      });
    });
  }
  return segments;
}

export type Placement = { column: number; columns: number; span: number };

/**
 * Side-by-side layout for overlapping intervals. Each cluster of transitively
 * overlapping items gets as many columns as it needs; items then widen into
 * free columns on their right. `minLength` is the shortest drawn length.
 */
export function layoutColumns<
  T extends { startMinute: number; endMinute: number },
>(items: T[], minLength = 0): (T & Placement)[] {
  const visualEnd = (item: T) =>
    Math.max(item.endMinute, item.startMinute + minLength);
  const sorted = items.toSorted(
    (a, b) => a.startMinute - b.startMinute || visualEnd(b) - visualEnd(a),
  );
  const result: (T & Placement)[] = [];
  let cluster: { item: T; column: number }[] = [];
  let columnEnds: number[] = [];
  let clusterEnd = -Infinity;
  const flush = () => {
    const columns = columnEnds.length;
    for (const { item, column } of cluster) {
      let span = 1;
      for (let next = column + 1; next < columns; next += 1) {
        const blocked = cluster.some(
          (other) =>
            other.column === next &&
            other.item.startMinute < visualEnd(item) &&
            visualEnd(other.item) > item.startMinute,
        );
        if (blocked) break;
        span += 1;
      }
      result.push({ ...item, column, columns, span });
    }
    cluster = [];
    columnEnds = [];
    clusterEnd = -Infinity;
  };
  for (const item of sorted) {
    if (cluster.length > 0 && item.startMinute >= clusterEnd) flush();
    let column = columnEnds.findIndex((end) => end <= item.startMinute);
    if (column === -1) column = columnEnds.length;
    columnEnds[column] = visualEnd(item);
    cluster.push({ item, column });
    clusterEnd = Math.max(clusterEnd, visualEnd(item));
  }
  flush();
  return result;
}

export type SpanItem = {
  event: CalendarEvent;
  /** First visible column, inclusive. */
  startColumn: number;
  /** Last visible column, exclusive. */
  endColumn: number;
  lane: number;
  startsBefore: boolean;
  endsAfter: boolean;
};

/** Columns covered by an event within `days` columns starting at `start`. */
export function spanColumns(
  event: Timing,
  start: Date,
  days: number,
): Omit<SpanItem, "event" | "lane"> | null {
  const from = eventStart(event);
  const to = eventEnd(event);
  const first = dayDifference(start, from);
  let last: number;
  if (event.allDay) last = dayDifference(start, to);
  else if (to > from)
    last = dayDifference(start, new Date(to.getTime() - 1)) + 1;
  else last = first + 1;
  if (last <= first) last = first + 1;
  if (last <= 0 || first >= days) return null;
  return {
    startColumn: Math.max(0, first),
    endColumn: Math.min(days, last),
    startsBefore: first < 0,
    endsAfter: last > days,
  };
}

/** Pack events into lanes so that no two items in a lane share a day. */
export function spanLanes(
  events: CalendarEvent[],
  start: Date,
  days: number,
): { items: SpanItem[]; lanes: number } {
  const placed = events
    .flatMap((event) => {
      const columns = spanColumns(event, start, days);
      return columns ? [{ ...columns, event, lane: 0 }] : [];
    })
    .toSorted(
      (a, b) =>
        a.startColumn - b.startColumn ||
        b.endColumn - b.startColumn - (a.endColumn - a.startColumn) ||
        Number(b.event.allDay) - Number(a.event.allDay) ||
        eventStart(a.event).getTime() - eventStart(b.event).getTime() ||
        a.event.title.localeCompare(b.event.title),
    );
  const laneEnds: number[] = [];
  for (const item of placed) {
    let lane = laneEnds.findIndex((end) => end <= item.startColumn);
    if (lane === -1) lane = laneEnds.length;
    laneEnds[lane] = item.endColumn;
    item.lane = lane;
  }
  return { items: placed, lanes: laneEnds.length };
}

/** Per column, the number of items hidden beyond `visibleLanes`. */
export function hiddenCounts(
  items: SpanItem[],
  days: number,
  visibleLanes: number,
): number[] {
  const counts = Array.from({ length: days }, () => 0);
  for (const item of items) {
    if (item.lane < visibleLanes) continue;
    for (let column = item.startColumn; column < item.endColumn; column += 1)
      counts[column] = (counts[column] ?? 0) + 1;
  }
  return counts;
}

export type EventTiming = { start: string; end: string };

/** New timing after moving an event to start at `start`, keeping duration. */
export function moveTo(event: Timing, start: Date): EventTiming {
  const duration = eventEnd(event).getTime() - eventStart(event).getTime();
  if (event.allDay) {
    const days = Math.max(1, Math.round(duration / DAY_MS));
    return { start: toAllDay(start), end: toAllDay(addDays(start, days)) };
  }
  return {
    start: start.toISOString(),
    end: new Date(start.getTime() + duration).toISOString(),
  };
}

/** Shift an event by whole days, preserving its wall-clock times. */
export function shiftDays(event: Timing, days: number): EventTiming {
  if (event.allDay)
    return {
      start: toAllDay(addDays(eventStart(event), days)),
      end: toAllDay(addDays(eventEnd(event), days)),
    };
  return moveTo(event, addDays(eventStart(event), days));
}

/** Timed end change with a minimum duration of `minMinutes`. */
export function resizeTo(
  event: Timing,
  end: Date,
  minMinutes = 15,
): EventTiming {
  const start = eventStart(event);
  const earliest = start.getTime() + minMinutes * 60_000;
  return {
    start: start.toISOString(),
    end: new Date(Math.max(earliest, end.getTime())).toISOString(),
  };
}

export function matchesSearch(event: CalendarEvent, query: string): boolean {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return true;
  return [event.title, event.location, event.description].some((value) =>
    value.toLocaleLowerCase().includes(needle),
  );
}

/** Date and time input values (`YYYY-MM-DD`, `HH:MM`) in local time. */
export function toDateInput(date: Date): string {
  return dayKey(date);
}

export function toTimeInput(date: Date): string {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

export function fromInputs(date: string, time = "00:00"): Date | null {
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const timeMatch = /^(\d{2}):(\d{2})$/.exec(time);
  if (!dateMatch || !timeMatch) return null;
  const [, year, month, day] = dateMatch.map(Number);
  const [, hours, minutes] = timeMatch.map(Number);
  if (
    year === undefined ||
    month === undefined ||
    day === undefined ||
    hours === undefined ||
    minutes === undefined
  )
    return null;
  const result = new Date(year, month - 1, day, hours, minutes);
  return result.getDate() === day ? result : null;
}

export type EventForm = {
  title: string;
  allDay: boolean;
  startDate: string;
  startTime: string;
  endDate: string;
  endTime: string;
  recurrence: Recurrence;
  calendarId: string;
  location: string;
  description: string;
};

/** Editor fields for an event. All-day end dates are shown inclusive. */
export function formFromEvent(
  event: Pick<
    CalendarEvent,
    | "title"
    | "allDay"
    | "start"
    | "end"
    | "recurrence"
    | "calendarId"
    | "location"
    | "description"
  >,
): EventForm {
  const start = eventStart(event);
  const end = eventEnd(event);
  const shownEnd = event.allDay ? addDays(end, -1) : end;
  return {
    title: event.title,
    allDay: event.allDay,
    startDate: toDateInput(start),
    startTime: toTimeInput(start),
    endDate: toDateInput(shownEnd < start ? start : shownEnd),
    endTime: toTimeInput(end),
    recurrence: event.recurrence,
    calendarId: event.calendarId,
    location: event.location,
    description: event.description,
  };
}

/** Keep the duration when the start moves, as calendar editors do. */
export function shiftFormStart(
  form: EventForm,
  startDate: string,
  startTime: string,
): EventForm {
  const next = { ...form, startDate, startTime };
  const oldStart = fromInputs(
    form.startDate,
    form.allDay ? "00:00" : form.startTime,
  );
  const oldEnd = fromInputs(form.endDate, form.allDay ? "00:00" : form.endTime);
  const newStart = fromInputs(startDate, form.allDay ? "00:00" : startTime);
  if (!oldStart || !oldEnd || !newStart || oldEnd < oldStart) return next;
  if (form.allDay) {
    const end = addDays(newStart, dayDifference(oldStart, oldEnd));
    return { ...next, endDate: toDateInput(end) };
  }
  const end = new Date(
    newStart.getTime() + (oldEnd.getTime() - oldStart.getTime()),
  );
  return { ...next, endDate: toDateInput(end), endTime: toTimeInput(end) };
}

/** Contract timing from editor fields, or an error message. */
export function timingFromForm(
  form: EventForm,
): { start: string; end: string } | { error: string } {
  if (form.allDay) {
    const start = fromInputs(form.startDate);
    const last = fromInputs(form.endDate);
    if (!start || !last) return { error: "Enter valid dates." };
    if (last < start)
      return { error: "End date must be on or after the start date." };
    return { start: toAllDay(start), end: toAllDay(addDays(last, 1)) };
  }
  const start = fromInputs(form.startDate, form.startTime);
  const end = fromInputs(form.endDate, form.endTime);
  if (!start || !end) return { error: "Enter valid dates and times." };
  if (end <= start) return { error: "End must be after start." };
  return { start: start.toISOString(), end: end.toISOString() };
}

export const recurrenceLabels: Record<Recurrence, string> = {
  none: "Does not repeat",
  daily: "Every day",
  weekly: "Every week",
  monthly: "Every month",
  yearly: "Every year",
};

/** Dark or light text, whichever contrasts more with `hex`. */
export function textColorFor(hex: string): "#0a0710" | "#ffffff" {
  const channel = (offset: number) => {
    const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.039_28 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  const luminance =
    0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
  const night = 0.002_45; // relative luminance of #0a0710
  return (luminance + 0.05) / (night + 0.05) >= 1.05 / (luminance + 0.05)
    ? "#0a0710"
    : "#ffffff";
}

export const calendarPalette: { name: string; color: string }[] = [
  { name: "Violet", color: "#6d4bd8" },
  { name: "Blue", color: "#2f6fde" },
  { name: "Teal", color: "#0f8b8d" },
  { name: "Green", color: "#2f9e44" },
  { name: "Lime", color: "#9ad15a" },
  { name: "Amber", color: "#e8a317" },
  { name: "Coral", color: "#e8590c" },
  { name: "Rose", color: "#d6336c" },
  { name: "Slate", color: "#5c6370" },
];

function formatter(
  locale: string | undefined,
  options: Intl.DateTimeFormatOptions,
) {
  return new Intl.DateTimeFormat(locale, options);
}

export function formatTime(date: Date, locale?: string): string {
  return formatter(locale, { hour: "numeric", minute: "2-digit" }).format(date);
}

export function formatHour(hour: number, locale?: string): string {
  return formatter(locale, { hour: "numeric" }).format(
    new Date(2000, 0, 1, hour),
  );
}

export function periodTitle(
  view: CalendarView,
  anchor: Date,
  range: DateRange,
  locale?: string,
): string {
  if (view === "month")
    return formatter(locale, { month: "long", year: "numeric" }).format(anchor);
  if (view === "day")
    return formatter(locale, {
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric",
    }).format(anchor);
  return formatter(locale, {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).formatRange(range.start, addDays(range.end, -1));
}

/** Human summary of an event's timing in the user's locale. */
export function formatEventRange(event: Timing, locale?: string): string {
  const start = eventStart(event);
  const end = eventEnd(event);
  const dateOptions: Intl.DateTimeFormatOptions = {
    weekday: "long",
    day: "numeric",
    month: "long",
  };
  if (event.allDay) {
    const last = addDays(end, -1);
    if (last <= start) return formatter(locale, dateOptions).format(start);
    return formatter(locale, dateOptions).formatRange(start, last);
  }
  if (
    sameDay(start, end) ||
    end.getTime() === addDays(startOfDay(start), 1).getTime()
  )
    return `${formatter(locale, dateOptions).format(start)} · ${formatter(
      locale,
      {
        hour: "numeric",
        minute: "2-digit",
      },
    ).formatRange(start, end)}`;
  return formatter(locale, {
    ...dateOptions,
    hour: "numeric",
    minute: "2-digit",
  }).formatRange(start, end);
}

/** Short offset label for the time gutter, such as `GMT+1`. */
export function timeZoneLabel(date: Date, locale?: string): string {
  return (
    formatter(locale, { timeZoneName: "shortOffset" })
      .formatToParts(date)
      .find((part) => part.type === "timeZoneName")?.value ?? ""
  );
}

export type EventChange =
  | { type: "create"; id: string; content: EventContent }
  | { type: "update"; event: CalendarEvent; content: EventContent }
  | { type: "delete"; event: CalendarEvent };

/**
 * Optimistic cache update. Recurring changes apply to every loaded
 * occurrence of the series; the next fetch replaces the approximation.
 */
export function applyEventChange(
  events: CalendarEvent[],
  change: EventChange,
): CalendarEvent[] {
  if (change.type === "create")
    return [
      ...events,
      { ...change.content, id: change.id, seriesId: change.id },
    ];
  if (change.type === "delete") {
    const { event } = change;
    return events.filter((item) =>
      event.recurrence === "none"
        ? item.id !== event.id
        : item.seriesId !== event.seriesId,
    );
  }
  const { event, content } = change;
  const delta = Date.parse(content.start) - Date.parse(event.start);
  const duration = Date.parse(content.end) - Date.parse(content.start);
  return events.flatMap((item) => {
    if (item.id === event.id) return [{ ...item, ...content }];
    if (event.recurrence === "none" || item.seriesId !== event.seriesId)
      return [item];
    if (content.recurrence === "none") return [];
    const start = Date.parse(item.start) + delta;
    return [
      {
        ...item,
        ...content,
        start: new Date(start).toISOString(),
        end: new Date(start + duration).toISOString(),
      },
    ];
  });
}
