// Wall-clock times in IANA time zones, read with the browser's Intl data.

const HOUR = 3_600_000;
const localPattern = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/;
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(zone: string) {
  let found = formatters.get(zone);
  if (found === undefined) {
    found = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    formatters.set(zone, found);
  }
  return found;
}

export function isTimeZone(zone: string) {
  try {
    formatterFor(zone);
    return true;
  } catch {
    return false;
  }
}

/** The wall clock of `zone` at `instant`, as milliseconds on the UTC axis. */
function wallClock(instant: number, zone: string) {
  const fields: Record<string, number> = {};
  for (const part of formatterFor(zone).formatToParts(instant))
    fields[part.type] = Number(part.value);
  return Date.UTC(
    fields["year"] ?? 1970,
    (fields["month"] ?? 1) - 1,
    fields["day"] ?? 1,
    fields["hour"] ?? 0,
    fields["minute"] ?? 0,
    fields["second"] ?? 0,
  );
}

/**
 * The instant of local time `local` ("2026-11-05T10:00:00") in `zone`. Like
 * RFC 5545, a repeated time takes its first occurrence and a skipped time
 * keeps the offset in force before the change. Undefined when either is
 * invalid.
 */
export function zonedInstant(local: string, zone: string) {
  const match = localPattern.exec(local);
  if (match === null || !isTimeZone(zone)) return undefined;
  const [year, month, day, hour, minute, second] = match
    .slice(1)
    .map((value) => Number(value));
  const wall = Date.UTC(
    year ?? 0,
    (month ?? 1) - 1,
    day ?? 1,
    hour ?? 0,
    minute ?? 0,
    second ?? 0,
  );
  if (new Date(wall).toISOString().slice(0, 19) !== local) return undefined;
  // Offsets change at most once around a given day in real zones.
  const earlier =
    wall - (wallClock(wall - 24 * HOUR, zone) - (wall - 24 * HOUR));
  const later = wall - (wallClock(wall + 24 * HOUR, zone) - (wall + 24 * HOUR));
  const exact = [earlier, later].filter(
    (instant) => wallClock(instant, zone) === wall,
  );
  return exact.length > 0 ? Math.min(...exact) : earlier;
}
