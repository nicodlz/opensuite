import { createHash } from "node:crypto";
import ICAL from "ical.js";
import type { PortableExportTools } from "@opensuite/contracts";
import { fetchCalendarObjects, fetchCalendars } from "tsdav";
import { z } from "zod";
import { portableExportLimits } from "@opensuite/contracts";

/** mboxrd quotes every From line, including already quoted lines. */
export function mboxMessage(raw: Uint8Array): Buffer {
  const text = Buffer.from(raw)
    .toString("latin1")
    .replace(/(^|\n)(>*From )/g, "$1>$2");
  const ending = text.endsWith("\n") ? "\n" : "\n\n";
  return Buffer.from(
    `From MAILER-DAEMON Thu Jan  1 00:00:00 1970\n${text}${ending}`,
    "latin1",
  );
}

function boundedCalendarFetch(origin: string, home: string): typeof fetch {
  let received = 0;
  return async (resource, options) => {
    const target = new URL(
      resource instanceof Request ? resource.url : String(resource),
      origin,
    );
    if (target.origin !== origin || !target.pathname.startsWith(home))
      throw new Error("Unexpected calendar endpoint");
    const response = await fetch(target, {
      ...options,
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
    const reader = response.body?.getReader();
    if (!reader) return response;
    const chunks: Uint8Array[] = [];
    const read = async (): Promise<void> => {
      const part = z
        .object({
          done: z.boolean(),
          value: z.instanceof(Uint8Array).optional(),
        })
        .parse(await reader.read());
      if (part.done) return;
      if (!part.value) throw new Error("Missing stream chunk");
      received += part.value.byteLength;
      if (received > portableExportLimits.calendarBytes) {
        await reader.cancel();
        throw new Error("Calendar response exceeds limit");
      }
      chunks.push(part.value);
      return read();
    };
    try {
      await read();
    } finally {
      reader.releaseLock();
    }
    return new Response(
      Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))),
      {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      },
    );
  };
}
function replaceZoneReferences(
  component: ICAL.Component,
  ids: Map<string, string>,
) {
  for (const property of component.getAllProperties()) {
    const from = property.getParameter("tzid");
    if (typeof from !== "string") continue;
    const to = ids.get(from);
    if (to !== undefined) property.setParameter("tzid", to);
  }
  for (const child of component.getAllSubcomponents())
    replaceZoneReferences(child, ids);
}
class CalendarCollector {
  readonly root = new ICAL.Component("vcalendar");
  readonly zones = new Map<string, string>();
  readonly renamedZones = new Map<string, string>();
  readonly fields = new Map<string, Set<string>>();
  readonly occurrences = new Map<string, Set<string>>();
  readonly warnings = new Set<string>();
  readonly failures: { id: string; reason: string }[] = [];
  count = 0;
  constructor() {
    this.root.addPropertyWithValue("version", "2.0");
    this.root.addPropertyWithValue("prodid", "-//Esuno//Portable export//EN");
  }
  renamedZoneId(id: string, text: string, used: Set<string>) {
    const hash = createHash("sha256")
      .update(id)
      .update("\0")
      .update(text)
      .digest("hex");
    let name = `X-ESUNO-${hash}`;
    let suffix = 0;
    while (used.has(name) || this.zones.has(name))
      name = `X-ESUNO-${hash}-${String(++suffix)}`;
    return name;
  }
  addZones(source: ICAL.Component) {
    const zones = source.getAllSubcomponents("vtimezone");
    const seen = new Set<string>();
    for (const zone of zones) {
      const original = String(zone.getFirstPropertyValue("tzid") ?? "");
      if (!original || seen.has(original))
        throw new Error("Ambiguous time zone");
      seen.add(original);
    }
    const replacements = new Map<string, string>();
    for (const zone of zones) {
      const original = String(zone.getFirstPropertyValue("tzid"));
      const previous = this.zones.get(original);
      const definition = zone.toString();
      if (previous !== undefined && previous !== definition) {
        const key = JSON.stringify([original, definition]);
        const replacement =
          this.renamedZones.get(key) ??
          this.renamedZoneId(original, definition, seen);
        this.renamedZones.set(key, replacement);
        seen.add(replacement);
        replacements.set(original, replacement);
        this.warnings.add(
          "Conflicting time-zone identifiers were renamed to preserve their definitions.",
        );
      }
    }
    replaceZoneReferences(source, replacements);
    for (const zone of zones) {
      const original = String(zone.getFirstPropertyValue("tzid"));
      const id = replacements.get(original) ?? original;
      if (id !== original) zone.updatePropertyWithValue("tzid", id);
      if (!this.zones.has(id)) {
        this.zones.set(id, zone.toString());
        this.root.addSubcomponent(
          new ICAL.Component(structuredClone(zone.jCal)),
        );
      }
    }
  }
  recordOccurrences(component: ICAL.Component, uid: string) {
    const keys = this.occurrences.get(uid) ?? new Set<string>();
    for (const name of ["recurrence-id", "exdate", "rdate"]) {
      for (const property of component.getAllProperties(name)) {
        for (const entry of property.getValues())
          if (entry instanceof ICAL.Time)
            keys.add(entry.toString().replace(/Z$/, ""));
      }
    }
    this.occurrences.set(uid, keys);
  }
  recordEvent(component: ICAL.Component) {
    const uid = String(component.getFirstPropertyValue("uid") ?? "");
    const present = this.fields.get(uid) ?? new Set<string>();
    for (const prop of component.getAllProperties()) present.add(prop.name);
    if (component.getAllSubcomponents("valarm").length) present.add("valarm");
    const start = component.getFirstProperty("dtstart");
    const startValue = start?.getFirstValue();
    if (
      start?.getParameter("tzid") ||
      (startValue instanceof ICAL.Time && startValue.toString().endsWith("Z"))
    )
      present.add("tzid");
    if (startValue instanceof ICAL.Time && startValue.isDate)
      present.add("all-day");
    this.fields.set(uid, present);
    this.recordOccurrences(component, uid);
  }
  addObject(data: unknown, label: string) {
    try {
      const source = ICAL.Component.fromString(
        z.string().max(portableExportLimits.calendarBytes).parse(data),
      );
      if (source.name !== "vcalendar") throw new Error("Invalid calendar");
      this.addZones(source);
      for (const component of source.getAllSubcomponents()) {
        if (component.name === "vtimezone") continue;
        this.root.addSubcomponent(
          new ICAL.Component(structuredClone(component.jCal)),
        );
        if (component.name === "vevent") this.recordEvent(component);
      }
      if (
        source
          .getAllProperties()
          .some((p) => !["version", "prodid", "calscale"].includes(p.name))
      )
        this.warnings.add(
          "Calendar-level properties other than VERSION, PRODID and CALSCALE were omitted when combining calendars.",
        );
      this.count++;
    } catch {
      if (this.failures.length < 1000)
        this.failures.push({
          id: label,
          reason: "Invalid item or ambiguous time zone.",
        });
      else
        this.warnings.add(
          "Additional calendar failures were omitted; inspect the source with a CalDAV client.",
        );
    }
  }
}
type DavCalendar = Awaited<ReturnType<typeof fetchCalendars>>[number];
async function collectCalendar(
  calendar: DavCalendar,
  index: number,
  headers: Record<string, string>,
  fetcher: typeof fetch,
  output: CalendarCollector,
) {
  try {
    const objects = await fetchCalendarObjects({
      calendar,
      headers,
      fetch: fetcher,
      urlFilter: (url) => !url.endsWith("/"),
    });
    if (objects.length > 1000) throw new Error("Too many objects");
    for (const [objectIndex, object] of objects.entries())
      output.addObject(
        object.data,
        `Calendar ${String(index + 1)}, item ${String(objectIndex + 1)}`,
      );
  } catch {
    output.failures.push({
      id: `Calendar ${String(index + 1)}`,
      reason: "Calendar could not be read or exceeded the limit.",
    });
  }
}
/** CalDAV supplies the server's iCalendar representation, including exceptions and zones. */
export async function exportCalendars(input: {
  origin: string;
  address: string;
  secret: string;
}) {
  const origin = new URL(input.origin).origin;
  const home = `/dav/cal/${encodeURIComponent(input.address)}/`;
  const fetcher = boundedCalendarFetch(origin, home);
  const headers = {
    authorization: `Basic ${Buffer.from(`${input.address}:${input.secret}`).toString("base64")}`,
  };
  const account = {
    accountType: "caldav" as const,
    serverUrl: origin,
    rootUrl: origin,
    homeUrl: `${origin}${home}`,
  };
  const calendars = await fetchCalendars({ account, headers, fetch: fetcher });
  if (calendars.length > 100) throw new Error("Too many calendars");
  const output = new CalendarCollector();
  await calendars.reduce(
    (prior, calendar, index) =>
      prior.then(() =>
        collectCalendar(calendar, index, headers, fetcher, output),
      ),
    Promise.resolve(),
  );
  if (calendars.length)
    output.warnings.add(
      "Calendar names, colours and membership are not retained in the combined file.",
    );
  output.warnings.add(
    "The calendar server supplies the iCalendar representation; fields it cannot represent in iCalendar are unavailable in this export.",
  );
  return {
    root: output.root,
    exported: output.count,
    warnings: [...output.warnings],
    failures: output.failures,
    fields: output.fields,
    occurrences: output.occurrences,
  };
}
const ruleSchema = z.strictObject({
  "@type": z.literal("RecurrenceRule").optional(),
  frequency: z.enum(["daily", "weekly", "monthly", "yearly"]),
  interval: z.number().int().min(1).max(9999).optional(),
  count: z.number().int().min(1).max(1_000_000).optional(),
  byDay: z
    .array(
      z.strictObject({
        "@type": z.literal("NDay").optional(),
        day: z.enum(["mo", "tu", "we", "th", "fr", "sa", "su"]),
        nthOfPeriod: z
          .number()
          .int()
          .min(-53)
          .max(53)
          .refine((n) => n !== 0)
          .optional(),
      }),
    )
    .min(1)
    .max(366)
    .optional(),
  byMonthDay: z
    .array(
      z
        .number()
        .int()
        .min(-31)
        .max(31)
        .refine((n) => n !== 0),
    )
    .min(1)
    .max(62)
    .optional(),
});
const frequency = {
  daily: "DAILY",
  weekly: "WEEKLY",
  monthly: "MONTHLY",
  yearly: "YEARLY",
} as const;
/** Translate the well-defined subset supported by the application into standard RRULEs. */
export function addCalendarRules(
  root: ICAL.Component,
  uid: string,
  raw: unknown,
): boolean {
  const rules = z.array(ruleSchema).min(1).max(1).safeParse(raw);
  const master = root
    .getAllSubcomponents("vevent")
    .find(
      (item) =>
        String(item.getFirstPropertyValue("uid") ?? "") === uid &&
        !item.hasProperty("recurrence-id"),
    );
  if (!rules.success || !master || master.hasProperty("rrule")) return false;
  const rule = rules.data[0];
  if (!rule) return false;
  const recur = ICAL.Recur.fromData({
    freq: frequency[rule.frequency],
    ...(rule.interval === undefined ? {} : { interval: rule.interval }),
    ...(rule.count === undefined ? {} : { count: rule.count }),
    ...(rule.byDay === undefined
      ? {}
      : {
          byday: rule.byDay.map(
            (day) => `${String(day.nthOfPeriod ?? "")}${day.day.toUpperCase()}`,
          ),
        }),
    ...(rule.byMonthDay === undefined ? {} : { bymonthday: rule.byMonthDay }),
  });
  master.addPropertyWithValue("rrule", recur);
  return true;
}

/** Translate a simple excluded occurrence, retaining the master's local time zone. */
export function addCalendarExclusion(
  root: ICAL.Component,
  uid: string,
  key: string,
  raw: unknown,
): boolean {
  const excluded = z.strictObject({ excluded: z.literal(true) }).safeParse(raw);
  if (!excluded.success || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(key))
    return false;
  const master = root
    .getAllSubcomponents("vevent")
    .find(
      (item) =>
        String(item.getFirstPropertyValue("uid") ?? "") === uid &&
        !item.hasProperty("recurrence-id"),
    );
  const start = master?.getFirstProperty("dtstart");
  const startTime = start?.getFirstValue();
  if (!master || !start || !(startTime instanceof ICAL.Time)) return false;
  try {
    const value = startTime.isDate
      ? ICAL.Time.fromDateString(key.slice(0, 10))
      : ICAL.Time.fromDateTimeString(
          startTime.toString().endsWith("Z") ? `${key}Z` : key,
        );
    const property = master.addPropertyWithValue("exdate", value);
    const tzid = start.getParameter("tzid");
    if (typeof tzid === "string" && !startTime.isDate)
      property.setParameter("tzid", tzid);
    return true;
  } catch {
    return false;
  }
}

function calendarRoot(root: unknown): ICAL.Component {
  if (!(root instanceof ICAL.Component))
    throw new Error("Invalid calendar export");
  return root;
}
export const portableExportTools: PortableExportTools = {
  calendars: exportCalendars,
  addRules: (root, uid, rules) =>
    addCalendarRules(calendarRoot(root), uid, rules),
  addExclusion: (root, uid, key, patch) =>
    addCalendarExclusion(calendarRoot(root), uid, key, patch),
  serialize: (root) => Buffer.from(`${calendarRoot(root).toString()}\r\n`),
  mboxMessage,
};
