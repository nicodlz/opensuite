import { z } from "zod";
import { err, ok } from "neverthrow";
import { SetSchema, usingCalendars, type CalendarEvent } from "./schemas.ts";
import type { JmapResult, Session } from "./protocol.ts";
import { createdItem, updatedItem } from "./set-results.ts";
import { ContactsClient } from "./contacts-client.ts";

const scanPageSize = 500;
const maxScanPages = 40;

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
  client: CalendarImportClient,
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
  client: CalendarImportClient,
  session: Session,
  accountId: string,
  uids: ReadonlySet<string>,
  cursor: ScanCursor,
  page: number,
): Promise<JmapResult<{ state: string; found: CalendarEvent[] }>> {
  const limit = page === maxScanPages ? 1 : scanPageSize;
  const response = await client.calendarEventPage(session, accountId, {
    filter: {},
    position: page * scanPageSize,
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
  if (page === maxScanPages && data.query.ids.length)
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
  if (data.query.ids.length === limit && page < maxScanPages)
    return scanPage(client, session, accountId, uids, cursor, page + 1);
  return verifyScan(client, session, accountId, cursor);
}

export class CalendarImportClient extends ContactsClient {
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
}
