import { z } from "zod";
import { err, ok } from "neverthrow";
import { SetSchema, usingCalendars, type CalendarEvent } from "./schemas.ts";
import type { JmapResult, Session } from "./protocol.ts";
import { createdItem, updatedItem } from "./set-results.ts";
import { ContactsClient } from "./contacts-client.ts";
import { threadPage } from "./thread-page.ts";

export { JmapCapability } from "./protocol.ts";
export type {
  JmapError,
  JmapResult,
  Session,
  TransportOptions,
} from "./protocol.ts";
export type {
  Mailbox,
  Email,
  Identity,
  Calendar,
  CalendarEvent,
  RecurrenceRule,
} from "./schemas.ts";

export const stable = (v: unknown): string => {
  if (Array.isArray(v)) return JSON.stringify(v.map(stable));
  if (v && typeof v === "object")
    return JSON.stringify(
      Object.entries(v)
        .filter(([key]) => key !== "iCalendar")
        .toSorted(([a], [b]) => a.localeCompare(b))
        .map(([k, x]) => [k, stable(x)]),
    );
  return JSON.stringify(v);
};
export const equivalent = (
  wanted: Record<string, unknown>,
  actual: Record<string, unknown>,
  includeOverrides = true,
) => {
  const keys = [
    "uid",
    "title",
    "description",
    "start",
    "duration",
    "timeZone",
    "showWithoutTime",
    "recurrenceRules",
    "excludedRecurrenceRules",
    "recurrenceRule",
    "recurrenceOverrides",
    "participants",
    "organizerCalendarAddress",
    "alerts",
    "locations",
    "links",
  ];
  return keys.every(
    (key) =>
      (!includeOverrides && key === "recurrenceOverrides") ||
      wanted[key] === null ||
      wanted[key] === undefined ||
      stable(wanted[key]) === stable(actual[key]),
  );
};

export type ImportPreviewState =
  "new" | "update" | "duplicate" | "conflict" | "invalid";
type ImportIdentity = { source: string; eventId: string | null };
const previewConflict = (previewReason: string) => ({
  previewState: "conflict" as const,
  previewReason,
});
export function previewCalendarEvent(
  desired: Record<string, unknown>,
  matches: CalendarEvent[],
  identity: ImportIdentity | undefined,
  calendarId: string,
  source: string,
): { previewState: ImportPreviewState; previewReason: string | null } {
  if (!matches.length) {
    if (identity && identity.source !== source)
      return previewConflict("UID belongs to a different source");
    return { previewState: "new", previewReason: null };
  }
  const match = matches.length === 1 ? matches[0] : undefined;
  if (!match || !match.calendarIds[calendarId])
    return previewConflict("UID exists in another calendar or is ambiguous");
  if (
    !identity ||
    identity.source !== source ||
    !identity.eventId ||
    identity.eventId !== match.id
  )
    return previewConflict("UID belongs to a different or uncertain source");
  if (!equivalent(desired, match, false))
    return previewConflict("Existing series differs from the source");
  return previewOverrides(desired, match);
}

function previewOverrides(
  desired: Record<string, unknown>,
  match: CalendarEvent,
): { previewState: ImportPreviewState; previewReason: string | null } {
  const incoming = z
    .record(z.string(), z.unknown())
    .safeParse(desired["recurrenceOverrides"] ?? {});
  const current = z
    .record(z.string(), z.unknown())
    .safeParse(match.recurrenceOverrides ?? {});
  if (!incoming.success || !current.success)
    return previewConflict("Invalid recurrence overrides");
  const changed = Object.keys(incoming.data).find(
    (key) =>
      key in current.data &&
      stable(incoming.data[key]) !== stable(current.data[key]),
  );
  if (changed)
    return previewConflict(
      `Occurrence conflicts with existing event: ${changed}`,
    );
  return {
    previewState: Object.keys(incoming.data).some(
      (key) => !(key in current.data),
    )
      ? "update"
      : "duplicate",
    previewReason: null,
  };
}

function unsafeRecurrence(
  event: CalendarEvent,
  patch: Record<string, unknown>,
) {
  if (
    "recurrenceOverrides" in patch &&
    event.recurrenceOverrides &&
    Object.keys(event.recurrenceOverrides).length
  )
    return true;
  return (
    ("recurrenceRules" in patch ||
      "excludedRecurrenceRules" in patch ||
      "start" in patch ||
      "timeZone" in patch) &&
    ((
      event.recurrenceRules ??
      (event.recurrenceRule ? [event.recurrenceRule] : [])
    ).some((rule) =>
      Object.keys(rule).some((key) => !["@type", "frequency"].includes(key)),
    ) ||
      (event.excludedRecurrenceRules?.length ?? 0) > 0)
  );
}
function unsafeAlerts(event: CalendarEvent, patch: Record<string, unknown>) {
  if (!("alerts" in patch) || !event.alerts) return false;
  const alerts = Object.values(event.alerts);
  return (
    alerts.length !== 1 ||
    alerts.some((alert) => {
      if (!alert || typeof alert !== "object") return true;
      if (!("action" in alert) || alert.action !== "display") return true;
      if (
        Object.keys(alert).some(
          (key) => !["@type", "action", "trigger"].includes(key),
        )
      )
        return true;
      const trigger: unknown = "trigger" in alert ? alert.trigger : undefined;
      return (
        !trigger ||
        typeof trigger !== "object" ||
        !("@type" in trigger) ||
        trigger["@type"] !== "OffsetTrigger" ||
        ("relativeTo" in trigger && trigger.relativeTo !== "start") ||
        Object.keys(trigger).some(
          (key) => !["@type", "offset", "relativeTo"].includes(key),
        )
      );
    })
  );
}
/** Refuse edits that would replace fields the simple editor cannot represent. */
export function unsafeSimpleEdit(
  event: CalendarEvent,
  patch: Record<string, unknown>,
) {
  if (unsafeRecurrence(event, patch) || unsafeAlerts(event, patch)) return true;
  if (
    "locations" in patch &&
    event.locations &&
    (Object.keys(event.locations).length > 1 ||
      Object.values(event.locations).some((location) =>
        Object.keys(location).some((key) => !["@type", "name"].includes(key)),
      ))
  )
    return true;
  return Boolean(
    "description" in patch &&
    event["descriptionContentType"] &&
    event["descriptionContentType"] !== "text/plain",
  );
}

type CalendarPage = {
  query: { accountId: string; queryState: string; ids: string[] };
  events: {
    state: string;
    list: CalendarEvent[];
    notFound: string[];
  };
};
type ScanCursor = {
  queryState: string | null;
  state: string | null;
  seen: Set<string>;
  found: CalendarEvent[];
};
const changed = () =>
  err({
    kind: "method" as const,
    method: "CalendarEvent/query",
    type: "stateMismatch",
  });
function validScanPage(page: CalendarPage, accountId: string) {
  const ids = new Set(page.query.ids);
  const account = z.object({ accountId: z.string() }).safeParse(page.events);
  return (
    page.query.accountId === accountId &&
    account.success &&
    account.data.accountId === accountId &&
    page.events.notFound.length === 0 &&
    ids.size === page.query.ids.length &&
    page.events.list.length === ids.size &&
    page.events.list.every(
      (event) => Boolean(event.uid) && ids.has(event.id),
    ) &&
    new Set(page.events.list.map((event) => event.id)).size === ids.size
  );
}
async function verifyScan(
  client: JmapClient,
  session: Session,
  accountId: string,
  cursor: ScanCursor,
): Promise<JmapResult<{ state: string; found: CalendarEvent[] }>> {
  const probe = await client.calendarEventPage(session, accountId, {
    filter: {},
    position: 0,
    limit: 1,
  });
  if (probe.isErr()) return err(probe.error);
  if (
    !validScanPage(probe.value, accountId) ||
    probe.value.query.queryState !== cursor.queryState ||
    probe.value.events.state !== cursor.state
  )
    return changed();
  return ok({ state: cursor.state, found: cursor.found });
}
async function scanPage(
  client: JmapClient,
  session: Session,
  accountId: string,
  uids: ReadonlySet<string>,
  cursor: ScanCursor,
  page: number,
): Promise<JmapResult<{ state: string; found: CalendarEvent[] }>> {
  const limit = page === 40 ? 1 : 500;
  const response = await client.calendarEventPage(session, accountId, {
    filter: {},
    position: page * 500,
    limit,
  });
  if (response.isErr()) return err(response.error);
  const data = response.value;
  if (
    !validScanPage(data, accountId) ||
    (cursor.queryState !== null &&
      data.query.queryState !== cursor.queryState) ||
    (cursor.state !== null && data.events.state !== cursor.state) ||
    data.query.ids.some((id) => cursor.seen.has(id))
  )
    return changed();
  if (page === 40 && data.query.ids.length)
    return err({
      kind: "invalidResponse",
      message: "Too many calendar events",
    });
  cursor.queryState = data.query.queryState;
  cursor.state = data.events.state;
  for (const id of data.query.ids) cursor.seen.add(id);
  cursor.found.push(
    ...data.events.list.filter(
      (event) => event.uid !== undefined && uids.has(event.uid),
    ),
  );
  if (data.query.ids.length === limit && page < 40)
    return scanPage(client, session, accountId, uids, cursor, page + 1);
  return verifyScan(client, session, accountId, cursor);
}

/** The authorization value is supplied by the caller; keep user credentials server-side. */
export class JmapClient extends ContactsClient {
  previewCalendarEvent(
    desired: Record<string, unknown>,
    matches: CalendarEvent[],
    identity: ImportIdentity | undefined,
    calendarId: string,
    source: string,
  ) {
    return previewCalendarEvent(desired, matches, identity, calendarId, source);
  }
  calendarStable(value: unknown) {
    return stable(value);
  }
  calendarEquivalent(
    wanted: Record<string, unknown>,
    actual: Record<string, unknown>,
    includeOverrides = true,
  ) {
    return equivalent(wanted, actual, includeOverrides);
  }
  scanCalendarUids(
    session: Session,
    accountId: string,
    uids: readonly string[],
  ) {
    return scanPage(
      this,
      session,
      accountId,
      new Set(uids),
      { queryState: null, state: null, seen: new Set(), found: [] },
      0,
    );
  }
  scanCalendarUid(session: Session, accountId: string, uid: string) {
    return this.scanCalendarUids(session, accountId, [uid]);
  }

  async importCalendarEvent(
    session: Session,
    accountId: string,
    event: object,
    ifInState: string,
  ) {
    const method = "CalendarEvent/set";
    const result = await this.transport.call(
      session.apiUrl,
      method,
      {
        accountId,
        create: { item: event },
        ifInState,
        sendSchedulingMessages: false,
      },
      usingCalendars,
      SetSchema(z.object({ id: z.string() })),
    );
    return createdItem(method, result);
  }

  async importCalendarOverrides(
    session: Session,
    accountId: string,
    id: string,
    additions: Record<string, unknown>,
    ifInState: string,
    hasOverrides: boolean,
  ) {
    const method = "CalendarEvent/set";
    const patch = hasOverrides
      ? Object.fromEntries(
          Object.entries(additions).map(([key, value]) => [
            `recurrenceOverrides/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`,
            value,
          ]),
        )
      : { recurrenceOverrides: additions };
    const result = await this.transport.call(
      session.apiUrl,
      method,
      {
        accountId,
        update: { [id]: patch },
        ifInState,
        sendSchedulingMessages: false,
      },
      usingCalendars,
      SetSchema(z.unknown()),
    );
    return updatedItem(method, result, id);
  }

  threadPage(
    ...args: Parameters<typeof threadPage> extends [unknown, ...infer Rest]
      ? Rest
      : never
  ) {
    return threadPage(this.transport, ...args);
  }
}
