import type {
  CalendarEvent as ContractEvent,
  EventContent,
  Recurrence,
} from "@opensuite/contracts";
import type { CalendarEvent, RecurrenceRule } from "@opensuite/jmap";
import { z } from "zod";

// A "wall" is a local date-time encoded as milliseconds on the UTC axis, so
// calendar arithmetic (add days or months) never crosses an offset change.
const DAY = 86_400_000;
const floating = "UTC";
const formatters = new Map<string, Intl.DateTimeFormat>();
const formatter = (zone: string) => {
  let entry = formatters.get(zone);
  if (entry === undefined) {
    entry = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    if (formatters.size >= 512) formatters.clear();
    formatters.set(zone, entry);
  }
  return entry;
};
export const isTimeZone = (zone: string) => {
  try {
    formatter(zone);
    return true;
  } catch {
    return false;
  }
};
const wallOf = (
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
) => {
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, 0);
  return date.getTime();
};
const offset = (zone: string, instant: number) => {
  if (zone === "UTC" || zone === "Etc/UTC") return 0;
  const parts = Object.fromEntries(
    formatter(zone)
      .formatToParts(instant)
      .map((part) => [part.type, Number(part.value)]),
  );
  return (
    wallOf(
      parts["year"] ?? 1970,
      parts["month"] ?? 1,
      parts["day"] ?? 1,
      parts["hour"] ?? 0,
      parts["minute"] ?? 0,
      parts["second"] ?? 0,
    ) -
    Math.floor(instant / 1000) * 1000
  );
};
export const toWall = (instant: number, zone: string) =>
  instant + offset(zone, instant);
/**
 * Resolves a local time like RFC 5545: an ambiguous time takes its first
 * occurrence; a time inside a gap uses the offset from before the gap.
 */
export const toInstant = (wall: number, zone: string) => {
  const before = offset(zone, wall - DAY);
  const after = offset(zone, wall + DAY);
  const valid = [wall - before, wall - after].filter(
    (instant) => instant + offset(zone, instant) === wall,
  );
  return valid.length > 0 ? Math.min(...valid) : wall - before;
};
export const parseLocal = (text: string, zone: string) => {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z)?$/.exec(
      text,
    );
  if (match === null) return undefined;
  const [, year, month, day, hour, minute, second] = match.map(Number);
  const wall = wallOf(
    year ?? 0,
    month ?? 0,
    day ?? 0,
    hour ?? 0,
    minute ?? 0,
    second ?? 0,
  );
  if (formatLocal(wall) !== text.slice(0, 19)) return undefined;
  // A UTC value (as some clients write `until`) is read in the event zone.
  return match[7] === "Z" ? toWall(wall, zone) : wall;
};
export const formatLocal = (wall: number) =>
  new Date(wall).toISOString().slice(0, 19);
const compact = (wall: number) => formatLocal(wall).replaceAll(/[-:]/g, "");
const fromCompact = (text: string) =>
  /^\d{8}T\d{6}$/.test(text)
    ? parseLocal(
        `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}T${text.slice(9, 11)}:${text.slice(11, 13)}:${text.slice(13, 15)}`,
        floating,
      )
    : undefined;

interface Duration {
  days: number;
  ms: number;
}
export const parseDuration = (text: string): Duration => {
  const match =
    /^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(
      text,
    );
  if (match === null) return { days: 0, ms: 0 };
  const [weeks, days, hours, minutes, seconds] = match
    .slice(1)
    .map((part: string | undefined) => Number(part ?? 0));
  return {
    days: (weeks ?? 0) * 7 + (days ?? 0),
    ms: Math.round(
      ((hours ?? 0) * 3600 + (minutes ?? 0) * 60 + (seconds ?? 0)) * 1000,
    ),
  };
};
const formatDuration = (ms: number) => {
  const total = Math.round(ms / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const text = `${hours ? `${hours}H` : ""}${minutes ? `${minutes}M` : ""}${seconds ? `${seconds}S` : ""}`;
  return `PT${text || "0S"}`;
};

type Frequency = Exclude<Recurrence, "none">;
const frequencies: readonly string[] = [
  "daily",
  "weekly",
  "monthly",
  "yearly",
] satisfies Frequency[];
const isFrequency = (value: string): value is Frequency =>
  frequencies.includes(value);
const weekdays = ["mo", "tu", "we", "th", "fr", "sa", "su"];
type ByDay = { day: number; nth: number | undefined };
const ruleKeys = new Set([
  "@type",
  "frequency",
  "interval",
  "count",
  "until",
  "rscale",
  "skip",
  "firstDayOfWeek",
  "byDay",
  "byMonthDay",
]);
const ByDaySchema = z
  .array(
    z.looseObject({
      day: z.enum(["mo", "tu", "we", "th", "fr", "sa", "su"]),
      nthOfPeriod: z
        .number()
        .int()
        .min(-5)
        .max(5)
        .refine((value) => value !== 0)
        .optional(),
    }),
  )
  .min(1);
/** `byDay` entries, or null when absent or not understood. */
function byDayOf(rule: RecurrenceRule): ByDay[] | null {
  const parsed = ByDaySchema.safeParse(rule["byDay"]);
  return parsed.success
    ? parsed.data.map((entry) => ({
        day: weekdays.indexOf(entry.day),
        nth: entry.nthOfPeriod,
      }))
    : null;
}
const firstDayOf = (rule: RecurrenceRule) => {
  const value = rule["firstDayOfWeek"];
  return typeof value === "string" ? weekdays.indexOf(value) : 0;
};
function byMonthDayOf(rule: RecurrenceRule): number[] | null {
  const value = rule["byMonthDay"];
  if (!Array.isArray(value) || value.length === 0) return null;
  return value.every(
    (day) =>
      typeof day === "number" &&
      Number.isInteger(day) &&
      day !== 0 &&
      Math.abs(day) <= 31,
  )
    ? value.filter((day): day is number => typeof day === "number")
    : null;
}
/**
 * Rules this service expands exactly: plain daily, weekly, monthly and
 * yearly rules, weekly rules on several weekdays, and monthly rules on
 * weekdays (optionally the nth of the month) or days of the month. Other
 * parts (byMonth, bySetPosition, byHour…) are not expanded rather than
 * expanded wrongly; the stored rule is left untouched.
 */
const expandable = (rule: RecurrenceRule) => {
  if (!isFrequency(rule.frequency)) return false;
  if (rule["rscale"] !== undefined && rule["rscale"] !== "gregorian")
    return false;
  if (rule["skip"] !== undefined && rule["skip"] !== "omit") return false;
  if (rule["firstDayOfWeek"] !== undefined && firstDayOf(rule) < 0)
    return false;
  if (
    Object.keys(rule).some(
      (key) => !ruleKeys.has(key) && rule[key] !== undefined,
    )
  )
    return false;
  const hasByDay = rule["byDay"] !== undefined;
  const hasByMonthDay = rule["byMonthDay"] !== undefined;
  if (hasByDay && hasByMonthDay) return false;
  if (hasByDay) {
    const days = byDayOf(rule);
    if (days === null) return false;
    if (rule.frequency === "weekly")
      return days.every((day) => day.nth === undefined);
    return rule.frequency === "monthly";
  }
  if (hasByMonthDay)
    return rule.frequency === "monthly" && byMonthDayOf(rule) !== null;
  return true;
};

/** One stored JSCalendar event, normalized for expansion and mapping. */
export interface Series {
  id: string;
  calendarId: string;
  title: string;
  description: string;
  location: string;
  allDay: boolean;
  zone: string;
  wall: number;
  duration: Duration;
  recurrence: Recurrence;
  recurring: boolean;
  rules: RecurrenceRule[];
  excluded: RecurrenceRule[];
  overrides: Map<number, Record<string, unknown>>;
}
const locationOf = (locations: unknown) =>
  typeof locations === "object" && locations !== null
    ? (Object.values(locations)
        .map((item: unknown) =>
          typeof item === "object" &&
          item !== null &&
          "name" in item &&
          typeof item.name === "string"
            ? item.name.trim()
            : "",
        )
        .find(Boolean) ?? "")
    : "";

/** Returns undefined for events that cannot be placed on a calendar. */
export function toSeries(
  event: CalendarEvent,
  calendars: readonly string[],
): Series | undefined {
  const owned = Object.keys(event.calendarIds).filter(
    (id) => event.calendarIds[id],
  );
  const calendarId = owned.find((id) => calendars.includes(id)) ?? owned[0];
  const allDay = event.showWithoutTime;
  const zone =
    !allDay && event.timeZone !== null && isTimeZone(event.timeZone)
      ? event.timeZone
      : floating;
  const wall = parseLocal(event.start, zone);
  if (calendarId === undefined || wall === undefined) return undefined;
  const rules = event.recurrenceRules ?? [];
  const overrides = new Map<number, Record<string, unknown>>();
  for (const [key, patch] of Object.entries(event.recurrenceOverrides ?? {})) {
    const at = parseLocal(key, zone);
    if (at !== undefined) overrides.set(at, patch);
  }
  const first = rules[0];
  return {
    id: event.id,
    calendarId,
    title: event.title,
    description: event.description,
    location: locationOf(event.locations),
    allDay,
    zone,
    wall: allDay ? Math.floor(wall / DAY) * DAY : wall,
    duration: parseDuration(event.duration),
    // The closest simple value, even when the rule is not expanded here.
    recurrence:
      first !== undefined &&
      isFrequency(first.frequency) &&
      (first["rscale"] === undefined || first["rscale"] === "gregorian")
        ? first.frequency
        : "none",
    recurring: rules.length > 0 || overrides.size > 0,
    rules: rules.filter(expandable),
    excluded: (event.excludedRecurrenceRules ?? []).filter(expandable),
    overrides,
  };
}

const step = (wall: number, frequency: Frequency, amount: number) => {
  if (frequency === "daily") return wall + amount * DAY;
  if (frequency === "weekly") return wall + amount * 7 * DAY;
  const date = new Date(wall);
  const day = date.getUTCDate();
  const month = date.getUTCMonth();
  if (frequency === "monthly") date.setUTCMonth(month + amount, day);
  else date.setUTCFullYear(date.getUTCFullYear() + amount, month, day);
  // Invalid dates (31 February, 29 February in a common year) are skipped.
  return date.getUTCDate() === day ? date.getTime() : undefined;
};
const timeOfDay = (wall: number) => ((wall % DAY) + DAY) % DAY;
/** Monday = 0 for a local wall time. */
const weekdayOf = (wall: number) => (new Date(wall).getUTCDay() + 6) % 7;
const daysInMonth = (year: number, month: number) =>
  new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
/** Candidate local times inside one period, sorted. */
function periodWalls(
  rule: RecurrenceRule,
  series: Series,
  frequency: Frequency,
  period: number,
): number[] {
  const byDay = rule["byDay"] === undefined ? null : byDayOf(rule);
  const byMonthDay =
    rule["byMonthDay"] === undefined ? null : byMonthDayOf(rule);
  if (frequency === "weekly" && byDay !== null) {
    const firstDay = firstDayOf(rule);
    const shift = (weekdayOf(series.wall) - firstDay + 7) % 7;
    const weekStart = series.wall - shift * DAY + period * 7 * DAY;
    return [...new Set(byDay.map((item) => (item.day - firstDay + 7) % 7))]
      .toSorted((a, b) => a - b)
      .map((days) => weekStart + days * DAY);
  }
  if (frequency === "monthly" && (byDay !== null || byMonthDay !== null)) {
    const base = new Date(series.wall);
    const month = new Date(
      Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + period, 1),
    );
    const year = month.getUTCFullYear();
    const index = month.getUTCMonth();
    const length = daysInMonth(year, index);
    const days = new Set<number>();
    for (const day of byMonthDay ?? []) {
      const actual = day > 0 ? day : length + day + 1;
      if (actual >= 1 && actual <= length) days.add(actual);
    }
    for (const item of byDay ?? []) {
      const first = (item.day - weekdayOf(Date.UTC(year, index, 1)) + 7) % 7;
      const matches: number[] = [];
      for (let day = first + 1; day <= length; day += 7) matches.push(day);
      if (item.nth === undefined) for (const day of matches) days.add(day);
      else {
        const pick =
          item.nth > 0 ? matches[item.nth - 1] : matches.at(item.nth);
        if (pick !== undefined) days.add(pick);
      }
    }
    return [...days]
      .toSorted((a, b) => a - b)
      .map((day) => Date.UTC(year, index, day) + timeOfDay(series.wall));
  }
  const wall = step(series.wall, frequency, period);
  return wall === undefined ? [] : [wall];
}
const periodLength: Record<Frequency, number> = {
  daily: DAY,
  weekly: 7 * DAY,
  monthly: 31 * DAY,
  yearly: 366 * DAY,
};
/** Local start times produced by one rule, in order, up to `limit`. */
function ruleWalls(
  rule: RecurrenceRule,
  series: Series,
  from: number,
  limit: number,
) {
  if (!isFrequency(rule.frequency)) return [];
  const frequency = rule.frequency;
  const interval =
    Number.isSafeInteger(rule.interval) && (rule.interval ?? 0) > 0
      ? (rule.interval ?? 1)
      : 1;
  const count =
    Number.isSafeInteger(rule.count) && (rule.count ?? 0) > 0
      ? rule.count
      : undefined;
  const until =
    rule.until === undefined ? undefined : parseLocal(rule.until, series.zone);
  // Without a count, skip whole periods that end before `from`; the
  // estimate uses the longest period so it never skips too far.
  let index =
    count === undefined
      ? Math.max(
          0,
          Math.floor(
            (from - series.wall) / (periodLength[frequency] * interval),
          ) - 1,
        )
      : 0;
  let produced = 0;
  const walls: number[] = [];
  for (let guard = 0; guard < 200_000; guard += 1, index += 1) {
    for (const wall of periodWalls(rule, series, frequency, index * interval)) {
      if (wall < series.wall) continue;
      if (count !== undefined && produced >= count) return walls;
      if (wall > limit || (until !== undefined && wall > until)) return walls;
      produced += 1;
      if (wall >= from) walls.push(wall);
    }
  }
  return walls;
}

export interface Occurrence {
  id: string;
  wall: number;
  start: number;
  end: number;
  title: string;
  description: string;
  location: string;
}
const span = (series: Series, wall: number, duration: Duration) => {
  if (series.allDay) {
    const end = wall + duration.days * DAY + duration.ms;
    return { start: wall, end: end > wall ? end : wall + DAY };
  }
  const start = toInstant(wall, series.zone);
  const end = toInstant(wall + duration.days * DAY, series.zone) + duration.ms;
  return { start, end: Math.max(start, end) };
};
const occurrenceId = (series: Series, wall: number) =>
  series.recurring ? `${series.id}~${compact(wall)}` : series.id;
function occurrence(
  series: Series,
  wall: number,
  patch: Record<string, unknown> = {},
): Occurrence {
  const text = (key: string, fallback: string) => {
    const item = patch[key];
    return typeof item === "string" ? item : fallback;
  };
  const moved =
    typeof patch["start"] === "string"
      ? parseLocal(patch["start"], series.zone)
      : undefined;
  const duration =
    typeof patch["duration"] === "string"
      ? parseDuration(patch["duration"])
      : series.duration;
  const locations = patch["locations"];
  return {
    id: occurrenceId(series, wall),
    wall: moved ?? wall,
    ...span(series, moved ?? wall, duration),
    title: text("title", series.title),
    description: text("description", series.description),
    location: locations === undefined ? series.location : locationOf(locations),
  };
}

/** Occurrences overlapping [start, end), with overrides and exclusions. */
export function expand(series: Series, start: number, end: number) {
  const margin = 2 * DAY;
  const longest =
    Math.max(
      series.duration.days * DAY + series.duration.ms,
      ...[...series.overrides.values()].map((patch) => {
        const value =
          typeof patch["duration"] === "string"
            ? parseDuration(patch["duration"])
            : series.duration;
        return value.days * DAY + value.ms;
      }),
    ) + DAY;
  const from = start - longest - margin;
  const limit = end + margin;
  const walls = new Set<number>([series.wall]);
  for (const rule of series.rules)
    for (const wall of ruleWalls(rule, series, from, limit)) walls.add(wall);
  for (const rule of series.excluded)
    for (const wall of ruleWalls(rule, series, from, limit)) walls.delete(wall);
  const result: Occurrence[] = [];
  for (const wall of walls)
    if (!series.overrides.has(wall)) result.push(occurrence(series, wall));
  for (const [wall, patch] of series.overrides)
    if (patch["excluded"] !== true)
      result.push(occurrence(series, wall, patch));
  return result
    .filter(
      (item) =>
        item.start < end &&
        (item.end > start || (item.end === item.start && item.start >= start)),
    )
    .toSorted((a, b) => a.start - b.start);
}

/** Finds an occurrence by its `id` from `expand`, or the base event. */
export function locate(series: Series, id: string) {
  if (id === series.id) return occurrence(series, series.wall);
  const [seriesId, recurrenceId, ...rest] = id.split("~");
  const wall =
    recurrenceId === undefined ? undefined : fromCompact(recurrenceId);
  if (seriesId !== series.id || wall === undefined || rest.length > 0)
    return undefined;
  const patch = series.overrides.get(wall);
  if (patch?.["excluded"] === true) return undefined;
  return occurrence(series, wall, patch);
}
export const seriesIdOf = (id: string) => id.split("~")[0] ?? id;

export const toContract = (
  series: Series,
  item: Occurrence,
): ContractEvent => ({
  id: item.id,
  seriesId: series.id,
  calendarId: series.calendarId,
  title: item.title,
  description: item.description,
  location: item.location,
  start: new Date(item.start).toISOString(),
  end: new Date(item.end).toISOString(),
  allDay: series.allDay,
  timeZone: series.zone,
  recurrence: series.recurrence,
});

/** Validated local timing for new content; undefined when it is invalid. */
export function timing(content: EventContent) {
  const start = Date.parse(content.start);
  const end = Date.parse(content.end);
  if (!(end > start)) return undefined;
  if (content.allDay) {
    const wall = Math.floor(start / DAY) * DAY;
    const days = Math.max(1, Math.ceil((end - wall) / DAY));
    return {
      wall,
      zone: floating,
      start: formatLocal(wall),
      duration: `P${days}D`,
    };
  }
  if (!isTimeZone(content.timeZone)) return undefined;
  const wall = toWall(start, content.timeZone);
  return {
    wall,
    zone: content.timeZone,
    start: formatLocal(wall),
    duration: formatDuration(end - start),
  };
}
const rules = (recurrence: Recurrence) =>
  recurrence === "none"
    ? null
    : [{ "@type": "RecurrenceRule", frequency: recurrence }];
const locations = (location: string) =>
  location.trim()
    ? { main: { "@type": "Location", name: location.trim() } }
    : null;

export function createObject(
  content: EventContent,
  time: NonNullable<ReturnType<typeof timing>>,
) {
  const recurrenceRules = rules(content.recurrence);
  const place = locations(content.location);
  return {
    "@type": "Event",
    calendarIds: { [content.calendarId]: true },
    title: content.title,
    description: content.description,
    start: time.start,
    duration: time.duration,
    ...(content.allDay
      ? { showWithoutTime: true }
      : { timeZone: content.timeZone }),
    ...(place === null ? {} : { locations: place }),
    ...(recurrenceRules === null ? {} : { recurrenceRules }),
  };
}

/**
 * Minimal patch for an update requested through occurrence `current`.
 * Unchanged fields, including recurrence rules this API cannot express, are
 * left untouched. A time change through an occurrence shifts the series.
 */
export function updatePatch(
  series: Series,
  current: Occurrence,
  content: EventContent,
  time: NonNullable<ReturnType<typeof timing>>,
) {
  const patch: Record<string, unknown> = {};
  if (content.title !== series.title) patch["title"] = content.title;
  if (content.description !== series.description)
    patch["description"] = content.description;
  if (content.location.trim() !== series.location)
    patch["locations"] = locations(content.location);
  if (content.calendarId !== series.calendarId)
    patch["calendarIds"] = { [content.calendarId]: true };
  const moved =
    Date.parse(content.start) !== current.start ||
    Date.parse(content.end) !== current.end ||
    content.allDay !== series.allDay ||
    (!content.allDay && content.timeZone !== series.zone);
  const recurrenceChanged = content.recurrence !== series.recurrence;
  if (moved) {
    const wall = series.wall + (time.wall - current.wall);
    patch["start"] = formatLocal(wall);
    patch["duration"] = time.duration;
    patch["showWithoutTime"] = content.allDay;
    patch["timeZone"] = content.allDay ? null : content.timeZone;
    if (
      wall !== series.wall ||
      time.zone !== series.zone ||
      content.allDay !== series.allDay
    )
      patch["recurrenceOverrides"] = null;
  }
  if (recurrenceChanged) {
    patch["recurrenceRules"] = rules(content.recurrence);
    patch["excludedRecurrenceRules"] = null;
    patch["recurrenceOverrides"] = null;
  }
  return patch;
}
