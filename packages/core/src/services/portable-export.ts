import {
  portableExportLimits,
  type PortableExportInput,
  type PortableExportOutput,
  type CalendarExport,
  type PortableExportTools,
} from "@opensuite/contracts";
import type { Actor } from "./accounts.ts";
import { createJmapAccess, fail, value } from "./jmap-access.ts";

type Dependencies = Parameters<typeof createJmapAccess>[0] & {
  tools: PortableExportTools;
};
type Access = ReturnType<typeof createJmapAccess>;
type Connection = Awaited<ReturnType<Access["connect"]>>;
type Event = { id: string; uid?: string | undefined } & Record<string, unknown>;
type MailInput = Extract<PortableExportInput, { format: "eml" | "mbox" }>;
const calendarProperties: Record<string, string[]> = {
  title: ["summary"],
  description: ["description"],
  locations: ["location"],
  start: ["dtstart"],
  duration: ["duration", "dtend"],
  timeZone: ["tzid"],
  showWithoutTime: ["all-day"],
  recurrenceRules: ["rrule"],
  recurrenceRule: ["rrule"],
  excludedRecurrenceRules: ["exrule"],
  recurrenceOverrides: ["recurrence-id", "exdate", "rdate"],
  participants: ["attendee"],
  organizerCalendarAddress: ["organizer"],
  links: ["url", "attach"],
  alerts: ["valarm"],
  status: ["status"],
  privacy: ["class"],
  freeBusyStatus: ["transp"],
  created: ["created"],
  updated: ["last-modified"],
  sequence: ["sequence"],
};
const calendarMetadata = new Set([
  "@type",
  "id",
  "uid",
  "calendarIds",
  "baseEventId",
  "isDraft",
  "isOrigin",
  "method",
  "version",
]);
function warn(result: CalendarExport, message: string) {
  if (result.warnings.length < 1000) result.warnings.push(message);
  else if (result.warnings.length === 1000)
    result.warnings.push(
      "Additional warnings were omitted; inspect the source with a CalDAV client.",
    );
}
function present(item: unknown): boolean {
  if (
    item === null ||
    item === undefined ||
    item === "" ||
    item === false ||
    item === 0
  )
    return false;
  if (Array.isArray(item)) return item.length > 0;
  if (typeof item === "object") return Object.keys(item).length > 0;
  return true;
}
function inspectFields(
  event: Event,
  fields: Set<string>,
  result: CalendarExport,
) {
  for (const [key, item] of Object.entries(event)) {
    if (!present(item) || calendarMetadata.has(key)) continue;
    const expected = calendarProperties[key];
    if (expected === undefined) {
      if (/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(key))
        warn(
          result,
          `Event ${event.id}: field ${key} may not be represented in iCalendar.`,
        );
    } else if (!expected.some((name) => fields.has(name)))
      warn(
        result,
        `Event ${event.id}: field ${key} is not represented in the calendar download.`,
      );
  }
}
function inspectOverrides(
  event: Event,
  fields: Set<string>,
  result: CalendarExport,
  tools: PortableExportTools,
) {
  const overrides = event["recurrenceOverrides"];
  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides))
    return;
  const represented =
    result.occurrences.get(event.uid ?? "") ?? new Set<string>();
  for (const [key, patch] of Object.entries(overrides)) {
    const occurrenceKey =
      fields.has("all-day") && key.endsWith("T00:00:00")
        ? key.slice(0, 10)
        : key.replace(/Z$/, "");
    if (represented.has(occurrenceKey)) continue;
    if (
      event.uid !== undefined &&
      tools.addExclusion(result.root, event.uid, key, patch)
    ) {
      fields.add("exdate");
      warn(
        result,
        `Event ${event.id}: converted an excluded occurrence to an iCalendar EXDATE.`,
      );
    } else
      warn(
        result,
        `Event ${event.id}: a recurrence exception is not represented in the calendar download.`,
      );
  }
}
function inspectEvent(
  event: Event,
  result: CalendarExport,
  tools: PortableExportTools,
) {
  const fields =
    event.uid === undefined ? undefined : result.fields.get(event.uid);
  if (fields === undefined) {
    if (result.failures.length < 1000)
      result.failures.push({
        id: event.id,
        reason: "Event was not found in the calendar download.",
      });
    else
      warn(
        result,
        "Additional calendar failures were omitted; inspect the source with a CalDAV client.",
      );
    return;
  }
  if (
    !fields.has("rrule") &&
    event.uid !== undefined &&
    tools.addRules(result.root, event.uid, event["recurrenceRules"])
  ) {
    fields.add("rrule");
    warn(
      result,
      `Event ${event.id}: converted its recurrence to an iCalendar RRULE.`,
    );
  }
  inspectOverrides(event, fields, result, tools);
  inspectFields(event, fields, result);
}
async function inspectPages(
  connection: Connection,
  result: CalendarExport,
  tools: PortableExportTools,
) {
  let queryState: string | undefined;
  let eventState: string | undefined;
  const pageAt = async (position: number): Promise<void> => {
    if (position > 1000) return fail("validation");
    const page = value(
      await connection.client.portableCalendarPage(
        connection.session,
        connection.id,
        position,
      ),
    );
    if (
      (queryState !== undefined && queryState !== page.query.queryState) ||
      (eventState !== undefined && eventState !== page.events.state)
    )
      return fail("conflict");
    queryState = page.query.queryState;
    eventState = page.events.state;
    if (position === 1000 && page.query.ids.length) return fail("validation");
    for (const event of page.events.list) inspectEvent(event, result, tools);

    if (page.query.ids.length === 50) return pageAt(position + 50);
  };
  await pageAt(0);
}
async function calendarExport(
  actor: Actor,
  accountId: string,
  deps: Dependencies,
  access: Access,
): Promise<PortableExportOutput> {
  const connection = await access.connect(
    actor,
    accountId,
    "urn:ietf:params:jmap:calendars",
  );
  const credential = await deps.store.getForOwner(actor.id, accountId);
  if (credential.isErr()) return fail("unavailable");
  if (accountId !== "default" && credential.value.accountId !== accountId)
    return fail("forbidden");
  const result = await deps.tools.calendars({
    origin: deps.origin,
    address: credential.value.address,
    secret: credential.value.secret,
  });

  await inspectPages(connection, result, deps.tools);
  const bytes = Buffer.from(deps.tools.serialize(result.root));
  if (bytes.length > portableExportLimits.calendarBytes)
    return fail("validation");
  return {
    filename: "calendars.ics",
    contentType: "text/calendar",
    content: bytes.toString("base64"),
    exported: result.exported,
    warnings: result.warnings,
    failures: result.failures,
  };
}
type MailState = {
  total: number;
  parts: Buffer[];
  failures: { id: string; reason: string }[];
};
async function addMessage(
  id: string,
  item: { blobId: string; size: number } | undefined,
  input: MailInput,
  connection: Connection,
  tools: PortableExportTools,
  state: MailState,
) {
  if (!item) {
    state.failures.push({ id, reason: "Message not found." });
    return;
  }
  if (
    item.size > portableExportLimits.messageBytes ||
    state.total + item.size > portableExportLimits.totalBytes
  ) {
    state.failures.push({ id, reason: "Message exceeds the export limit." });
    return;
  }
  const raw = await connection.client.portableBlob(
    connection.session,
    connection.id,
    item.blobId,
    Math.min(
      portableExportLimits.messageBytes,
      portableExportLimits.totalBytes - state.total,
    ),
  );
  if (raw.isErr()) {
    state.failures.push({
      id,
      reason: "Message could not be downloaded or exceeded the limit.",
    });
    return;
  }
  const bytes =
    input.format === "mbox"
      ? Buffer.from(tools.mboxMessage(raw.value))
      : Buffer.from(raw.value);
  if (state.total + bytes.length > portableExportLimits.totalBytes) {
    state.failures.push({ id, reason: "Message exceeds the export limit." });
    return;
  }
  state.parts.push(bytes);
  state.total += bytes.length;
}
async function mailExport(
  actor: Actor,
  input: MailInput,
  deps: Dependencies,
  access: Access,
): Promise<PortableExportOutput> {
  const connection = await access.connect(
    actor,
    input.accountId,
    "urn:ietf:params:jmap:mail",
  );
  const ids = [...new Set(input.ids)];
  const metadata = value(
    await connection.client.portableMetadata(
      connection.session,
      connection.id,
      ids,
    ),
  );
  if (metadata.accountId !== connection.id) return fail("unavailable");
  const items = new Map(metadata.list.map((item) => [item.id, item]));
  const state: MailState = { parts: [], failures: [], total: 0 };
  await ids.reduce(
    (prior, id) =>
      prior.then(() =>
        addMessage(id, items.get(id), input, connection, deps.tools, state),
      ),
    Promise.resolve(),
  );
  return {
    filename: input.format === "eml" ? "message.eml" : "messages.mbox",
    contentType: input.format === "eml" ? "message/rfc822" : "application/mbox",
    content: Buffer.concat(state.parts).toString("base64"),
    exported: state.parts.length,
    failures: state.failures,
    warnings:
      input.format === "mbox"
        ? [
            "mboxrd quotes From lines and adds separators and line endings; use EML for exact MIME bytes.",
          ]
        : [],
  };
}
export function createPortableExportService(dependencies: Dependencies) {
  const access = createJmapAccess(dependencies);
  return {
    export: (actor: Actor, input: PortableExportInput) =>
      access.run(() =>
        input.format === "ics"
          ? calendarExport(actor, input.accountId, dependencies, access)
          : mailExport(actor, input, dependencies, access),
      ),
  };
}
export type PortableExportService = ReturnType<
  typeof createPortableExportService
>;
