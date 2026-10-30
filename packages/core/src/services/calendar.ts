import type { Calendar, EventContent } from "@opensuite/contracts";
import {
  JmapCapability,
  type Calendar as JmapCalendar,
  type JmapClient,
} from "@opensuite/jmap";
import type { Actor } from "./accounts.ts";
import {
  createObject,
  expand,
  locate,
  seriesIdOf,
  timing,
  toContract,
  toSeries,
  updatePatch,
} from "./calendar-time.ts";
import {
  createJmapAccess,
  fail,
  value,
  type AccessFailureKind,
  type MailCredentialStore,
} from "./jmap-access.ts";

export type CalendarFailureKind = AccessFailureKind;
export interface CalendarFailure {
  kind: CalendarFailureKind;
}
export const calendarPalette = [
  "#7c5cff",
  "#1f9d8b",
  "#e5484d",
  "#f76b15",
  "#3e63dd",
  "#d6409f",
  "#46a758",
  "#ffb224",
] as const;
const maxRangeMs = 400 * 86_400_000;
const pageSize = 500;
const maxPages = 40;

const colorOf = (color: string | null, index: number) => {
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(color ?? "");
  if (short !== null)
    return `#${short
      .slice(1)
      .map((part) => part.repeat(2))
      .join("")}`.toLowerCase();
  return color !== null && /^#[0-9a-f]{6}$/i.test(color)
    ? color.toLowerCase()
    : (calendarPalette[index % calendarPalette.length] ?? "#7c5cff");
};
export const toCalendars = (list: readonly JmapCalendar[]): Calendar[] => {
  const ordered = list.toSorted(
    (a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name),
  );
  const fallbackDefault = ordered.some((item) => item.isDefault)
    ? undefined
    : ordered[0]?.id;
  return ordered.map((item, index) => ({
    id: item.id,
    name: item.name || "Calendar",
    color: colorOf(item.color, index),
    isDefault: item.isDefault || item.id === fallbackDefault,
  }));
};

const validated = (content: EventContent) =>
  timing(content) ?? fail("validation");

/** One instance per server; credentials and client instances never leave this service. */
export function createCalendarService(dependencies: {
  store: MailCredentialStore;
  origin: string;
  client?: (credential: { address: string; secret: string }) => JmapClient;
  now?: () => number;
}) {
  const { run, connect: open } = createJmapAccess(dependencies);
  const connect = (actor: Actor, accountId: string) =>
    open(actor, accountId, JmapCapability.calendars);
  type Connection = Awaited<ReturnType<typeof connect>>;
  const creating = new Map<string, Promise<unknown>>();
  const list = async (c: Connection) =>
    value(await c.client.calendars(c.session, c.id)).list;
  const writable = async (c: Connection, calendarId: string) => {
    const calendars = await list(c);
    const calendar = calendars.find((item) => item.id === calendarId);
    if (calendar === undefined) return fail("not_found");
    if (calendar.myRights?.mayWriteAll === false) return fail("forbidden");
    return calendars.map((item) => item.id);
  };
  const series = async (c: Connection, id: string, calendars: string[]) => {
    const event = value(
      await c.client.calendarEvents(c.session, c.id, [id]),
    ).list.find((item) => item.id === id);
    if (event === undefined) return fail("not_found");
    return toSeries(event, calendars) ?? fail("unavailable");
  };
  const first = async (c: Connection, id: string, calendars: string[]) => {
    const stored = await series(c, id, calendars);
    return toContract(stored, locate(stored, stored.id) ?? fail("unavailable"));
  };
  return {
    calendars: (actor: Actor, accountId: string) =>
      run(async () => {
        const c = await connect(actor, accountId);
        let calendars = await list(c);
        if (calendars.length === 0) {
          // Concurrent first loads share one default calendar.
          const key = `${c.owner}:${c.id}`;
          let pending = creating.get(key);
          if (pending === undefined) {
            pending = (async () =>
              value(
                await c.client.createCalendar(
                  c.session,
                  c.id,
                  { name: "Calendar", color: calendarPalette[0] },
                  true,
                ),
              ))().finally(() => creating.delete(key));
            creating.set(key, pending);
          }
          await pending;
          calendars = await list(c);
        }
        return { calendars: toCalendars(calendars) };
      }),
    createCalendar: (
      actor: Actor,
      accountId: string,
      input: { name: string; color: string },
    ) =>
      run(async () => {
        const c = await connect(actor, accountId);
        const isDefault = (await list(c)).length === 0;
        const color = input.color.toLowerCase();
        const created = value(
          await c.client.createCalendar(
            c.session,
            c.id,
            { name: input.name, color },
            isDefault,
          ),
        );
        return { id: created.id, name: input.name, color, isDefault };
      }),
    events: (
      actor: Actor,
      accountId: string,
      range: { start: string; end: string; calendarIds?: string[] | undefined },
    ) =>
      run(async () => {
        const start = Date.parse(range.start);
        const end = Date.parse(range.end);
        if (!(end > start) || end - start > maxRangeMs)
          return fail("validation");
        const c = await connect(actor, accountId);
        const calendars = (await list(c)).map((item) => item.id);
        const selected = range.calendarIds;
        if (selected?.some((id) => !calendars.includes(id)))
          return fail("not_found");
        if (selected?.length === 0) return { events: [] };
        // Stalwart's time-range filter ignores recurrence rules, so every
        // event starting before the range end is a candidate.
        const filter = {
          before: new Date(end).toISOString().replace(/\.\d{3}Z$/, "Z"),
          ...(selected?.length === 1 ? { inCalendar: selected[0] } : {}),
        };
        const events: ReturnType<typeof toContract>[] = [];
        const page = async (index: number): Promise<void> => {
          if (index >= maxPages) return fail("unavailable");
          const result = value(
            await c.client.calendarEventPage(c.session, c.id, {
              filter,
              position: index * pageSize,
              limit: pageSize,
            }),
          );
          for (const event of result.events.list) {
            const item = toSeries(event, calendars);
            if (
              item === undefined ||
              (selected !== undefined && !selected.includes(item.calendarId))
            )
              continue;
            for (const occurrence of expand(item, start, end))
              events.push(toContract(item, occurrence));
          }
          if (result.query.ids.length >= pageSize) return page(index + 1);
          return undefined;
        };
        await page(0);
        return {
          events: events.toSorted(
            (a, b) =>
              a.start.localeCompare(b.start) || a.end.localeCompare(b.end),
          ),
        };
      }),
    createEvent: (actor: Actor, accountId: string, content: EventContent) =>
      run(async () => {
        const time = validated(content);
        const c = await connect(actor, accountId);
        const calendars = await writable(c, content.calendarId);
        const created = value(
          await c.client.createCalendarEvent(
            c.session,
            c.id,
            createObject(content, time),
          ),
        );
        return first(c, created.id, calendars);
      }),
    updateEvent: (
      actor: Actor,
      accountId: string,
      eventId: string,
      content: EventContent,
    ) =>
      run(async () => {
        const time = validated(content);
        const c = await connect(actor, accountId);
        const calendars = await writable(c, content.calendarId);
        const stored = await series(c, seriesIdOf(eventId), calendars);
        const current = locate(stored, eventId) ?? fail("not_found");
        const patch = updatePatch(stored, current, content, time);
        if (Object.keys(patch).length > 0)
          value(
            await c.client.updateCalendarEvent(
              c.session,
              c.id,
              stored.id,
              patch,
            ),
          );
        return first(c, stored.id, calendars);
      }),
    deleteEvent: (actor: Actor, accountId: string, eventId: string) =>
      run(async () => {
        const c = await connect(actor, accountId);
        const calendars = (await list(c)).map((item) => item.id);
        const stored = await series(c, seriesIdOf(eventId), calendars);
        if (locate(stored, eventId) === undefined) return fail("not_found");
        value(await c.client.destroyCalendarEvent(c.session, c.id, stored.id));
        return { success: true } satisfies { success: true };
      }),
  };
}
export type CalendarService = ReturnType<typeof createCalendarService>;
