const DAY = 86_400_000;
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
