import {
  CalendarImportJobSchema,
  type Calendar,
  type CalendarImportJob,
  type EventContent,
} from "@opensuite/contracts";
import type { CalendarImportStore } from "@opensuite/db";
import {
  JmapCapability,
  unsafeSimpleEdit,
  type Calendar as JmapCalendar,
  type JmapClient,
} from "@opensuite/jmap";
import type {
  CalendarImportService,
  ImportDependencies,
  ImportConnection,
  ImportJob,
} from "./migration-calendar.ts";
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
// Occurrences returned for one range; denser ranges must be narrowed.
const maxOccurrences = 10_000;

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

type Job = NonNullable<Awaited<ReturnType<CalendarImportStore["get"]>>>;
export const publicJob = (
  store: CalendarImportStore,
  job: Job,
): CalendarImportJob => CalendarImportJobSchema.parse(store.project(job));

export async function assertImportWritable(
  c: ImportConnection,
  calendarId: string,
) {
  const target =
    value(await c.client.calendars(c.session, c.id)).list.find(
      (item) => item.id === calendarId,
    ) ?? fail("not_found");
  if (target.myRights?.mayWriteAll === false) fail("forbidden");
}
export async function confirmCalendarImport(
  deps: ImportDependencies,
  c: ImportConnection,
  actor: Actor,
  job: ImportJob,
) {
  if (job.abandoned) return fail("conflict");
  await assertImportWritable(c, job.calendarId);
  if (
    !job.confirmed &&
    (await deps.imports.confirm(actor.id, job.id, job.generation)).count !== 1
  )
    return fail("conflict");
  return publicJob(
    deps.imports,
    (await deps.imports.get(actor.id, job.id)) ?? fail("not_found"),
  );
}
export async function recoverCalendarImport(
  deps: ImportDependencies,
  c: ImportConnection,
  actor: Actor,
  job: ImportJob,
  input: { action: "retarget"; calendarId: string } | { action: "abandon" },
) {
  if (job.abandoned) return fail("conflict");
  if (input.action === "retarget") {
    const calendars = value(await c.client.calendars(c.session, c.id)).list;
    if (calendars.some((calendar) => calendar.id === job.calendarId))
      return fail("conflict");
    const target =
      calendars.find((calendar) => calendar.id === input.calendarId) ??
      fail("not_found");
    if (target.myRights?.mayWriteAll === false) return fail("forbidden");
    const previews = value(
      await deps.parser.previews(
        c,
        deps.imports,
        actor.id,
        job.accountId,
        input.calendarId,
        job.items,
      ),
    );
    const preview = job.items.map((item, index) => ({
      id: item.id,
      ...(previews[index] ?? {
        previewState: "invalid" as const,
        previewReason: "Event could not be parsed",
      }),
    }));
    if (
      !(await deps.imports.recover(
        actor.id,
        job.id,
        job.generation,
        job.calendarId,
        { action: "retarget", calendarId: input.calendarId, preview },
      ))
    )
      return fail("conflict");
  } else if (
    !(await deps.imports.recover(
      actor.id,
      job.id,
      job.generation,
      job.calendarId,
      input,
    ))
  )
    return fail("conflict");
  return publicJob(
    deps.imports,
    (await deps.imports.get(actor.id, job.id)) ?? fail("not_found"),
  );
}

type CalendarConnection = Awaited<
  ReturnType<ReturnType<typeof createJmapAccess>["connect"]>
>;
async function prepareUpdate(
  c: CalendarConnection,
  calendars: string[],
  eventId: string,
  content: EventContent,
  time: NonNullable<ReturnType<typeof timing>>,
) {
  const raw =
    value(
      await c.client.calendarEvents(c.session, c.id, [seriesIdOf(eventId)]),
    ).list.find((item) => item.id === seriesIdOf(eventId)) ?? fail("not_found");
  const stored = toSeries(raw, calendars) ?? fail("unavailable");
  const current = locate(stored, eventId) ?? fail("not_found");
  const patch = updatePatch(stored, current, content, time);
  if (unsafeSimpleEdit(raw, patch)) return fail("conflict");
  return { stored, patch };
}

async function applyUpdate(
  c: CalendarConnection,
  calendars: string[],
  eventId: string,
  content: EventContent,
  time: NonNullable<ReturnType<typeof timing>>,
) {
  const { stored, patch } = await prepareUpdate(
    c,
    calendars,
    eventId,
    content,
    time,
  );
  if (Object.keys(patch).length > 0)
    value(
      await c.client.updateCalendarEvent(c.session, c.id, stored.id, patch),
    );
  return stored.id;
}

/** One instance per server; credentials and client instances never leave this service. */
export function createCalendarService(dependencies: {
  store: MailCredentialStore;
  origin: string;
  client?: (credential: { address: string; secret: string }) => JmapClient;
  now?: () => number;
  migration?: CalendarImportService;
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
    migration: dependencies.migration,
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
        // Stalwart's time-range filter ignores recurrence rules, and an
        // occurrence can be moved before its series starts, so every event
        // is a candidate. Expansion stops once the response would be too big.
        const filter =
          selected?.length === 1 ? { inCalendar: selected[0] } : {};
        const events: ReturnType<typeof toContract>[] = [];
        const page = async (index: number): Promise<void> => {
          if (index >= maxPages) {
            // A full last page is fine when nothing follows it.
            const rest = value(
              await c.client.calendarEventPage(c.session, c.id, {
                filter,
                position: index * pageSize,
                limit: 1,
              }),
            );
            return rest.query.ids.length === 0
              ? undefined
              : fail("unavailable");
          }
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
            if (events.length > maxOccurrences) return fail("validation");
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
        const id = await applyUpdate(c, calendars, eventId, content, time);
        return first(c, id, calendars);
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
export type CalendarService = Omit<
  ReturnType<typeof createCalendarService>,
  "migration"
> & { migration?: CalendarImportService | undefined };
