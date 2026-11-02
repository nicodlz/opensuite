import ICAL from "ical.js";
import { simpleParser } from "mailparser";
import { z } from "zod";
import { signingDomains } from "./authentication.ts";
import type {
  InvitationEvent,
  ParsedInvitation,
  ParsedInvitationReply,
} from "../../domain/invitations/types.ts";
import {
  addressSchema,
  mailbox,
  occurrenceKey,
  sequenceOf,
  stringValue,
  text,
  time,
} from "./common.ts";

const safeUrl = (value: string) => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
};
const meetingUrl = (event: ICAL.Component) => {
  const values = [
    ...event.getAllProperties("conference").map((p) => text(p.getFirstValue())),
    stringValue(event, "url"),
    ...[
      stringValue(event, "location"),
      stringValue(event, "description"),
    ].flatMap((value) => value.match(/https:\/\/[^\s<>"']+/gi) ?? []),
  ];
  return values.map(safeUrl).find((value) => value !== null) ?? null;
};

function parseEvent(component: ICAL.Component): InvitationEvent {
  const uid = stringValue(component, "uid");
  const organizers = component.getAllProperties("organizer");
  if (organizers.length !== 1) throw new Error("Invalid invitation organizer");
  const organizerProperty = organizers[0];
  const organizer = mailbox(organizerProperty?.getFirstValue());
  const sequence = sequenceOf(component);
  if (!uid || uid.length > 1024 || !organizer)
    throw new Error("Invalid invitation identity");
  const attendees = component.getAllProperties("attendee").map((property) => {
    const email = mailbox(property.getFirstValue());
    if (!email) throw new Error("Invalid attendee");
    return {
      email,
      name: property.getFirstParameter("cn") || null,
      partstat: (
        property.getFirstParameter("partstat") || "NEEDS-ACTION"
      ).toUpperCase(),
    };
  });
  return {
    uid,
    recurrenceId: time(component, "recurrence-id"),
    recurrenceIdTimeZone:
      component.getFirstProperty("recurrence-id")?.getFirstParameter("tzid") ||
      null,
    sequence,
    organizer: {
      email: organizer,
      name: organizerProperty?.getFirstParameter("cn") || null,
    },
    attendees,
    title: stringValue(component, "summary"),
    description: stringValue(component, "description"),
    location: stringValue(component, "location"),
    start: time(component, "dtstart"),
    end: time(component, "dtend"),
    timeZone:
      component.getFirstProperty("dtstart")?.getFirstParameter("tzid") || null,
    recurrence: component
      .getAllProperties("rrule")
      .map((property) => String(property.getFirstValue())),
    meetingUrl: meetingUrl(component),
  };
}

function validateMethod(
  root: ICAL.Component,
  allowed: "received" | "reply",
  contentType: unknown,
) {
  const method = stringValue(root, "method").toUpperCase();
  const parsed = z.enum(["REQUEST", "CANCEL", "REPLY"]).safeParse(method);
  if (
    root.name !== "vcalendar" ||
    !parsed.success ||
    (allowed === "reply" ? method !== "REPLY" : method === "REPLY")
  )
    throw new Error("Unsupported calendar method");
  if (
    typeof contentType === "object" &&
    contentType !== null &&
    "params" in contentType &&
    typeof contentType.params === "object" &&
    contentType.params !== null &&
    "method" in contentType.params &&
    text(contentType.params["method"]).toUpperCase() !== method
  )
    throw new Error("Calendar method mismatch");
  return parsed.data;
}
function calendarPart(
  allowed: "received" | "reply",
  attachments: Awaited<ReturnType<typeof simpleParser>>["attachments"],
): { root: ICAL.Component; method: "REQUEST" | "CANCEL" | "REPLY" } {
  const parts = attachments.filter(
    (part) => part.contentType.toLowerCase() === "text/calendar",
  );
  if (parts.length !== 1 || !parts[0] || parts[0].size > 1_000_000)
    throw new Error("Expected one calendar part");
  const contentType = parts[0].headers.get("content-type");
  const parameters = z
    .object({ params: z.record(z.string(), z.string()).optional() })
    .safeParse(contentType);
  const charset = parameters.success
    ? (parameters.data.params?.["charset"] ?? "utf-8")
    : "utf-8";
  const decoded = new TextDecoder(charset, { fatal: true }).decode(
    parts[0].content,
  );
  const root = ICAL.Component.fromString(decoded);
  const method = validateMethod(root, allowed, contentType);
  return { root, method };
}

/** Parse the original message with MIME and iCalendar libraries, without side effects. */
async function parseMessage(raw: Uint8Array, allowed: "received" | "reply") {
  if (raw.byteLength > 10_000_000) throw new Error("Message too large");
  const message = await simpleParser(Buffer.from(raw), {
    skipHtmlToText: true,
    skipTextToHtml: true,
    skipImageLinks: true,
  });
  const { root, method } = calendarPart(allowed, message.attachments);
  const components = root.getAllSubcomponents("vevent");
  if (!components.length || components.length > 100)
    throw new Error("Invalid events");
  const events = components.map(parseEvent);
  if (
    events.some(
      (event) =>
        event.uid !== events[0]?.uid ||
        event.organizer.email !== events[0].organizer.email,
    )
  )
    throw new Error("Inconsistent event identity");
  const collect = (items: typeof message.to) =>
    (Array.isArray(items) ? items : items ? [items] : []).flatMap((item) =>
      item.value.flatMap((entry) => {
        const parsed = addressSchema.safeParse(entry.address);
        return parsed.success ? [parsed.data.toLowerCase()] : [];
      }),
    );
  // Duplicate From fields are ambiguous even when the MIME parser selects one.
  const fromHeaders = message.headerLines.filter(
    (header) => header.key === "from",
  );
  const from =
    fromHeaders.length === 1 && message.from?.value.length === 1
      ? collect(message.from)
      : [];
  return {
    method,
    events,
    calendar: root.toString(),
    from,
    recipients: [...collect(message.to), ...collect(message.cc)],
    signingDomains: signingDomains(message),
    root,
  };
}

/** Parse a received REQUEST or CANCEL without changing the existing boundary. */
export async function parseInvitation(
  raw: Uint8Array,
): Promise<ParsedInvitation> {
  const parsed = await parseMessage(raw, "received");
  if (parsed.method === "REPLY") throw new Error("Unsupported calendar method");
  return {
    method: parsed.method,
    events: parsed.events,
    calendar: parsed.calendar,
    from: parsed.from,
    recipients: parsed.recipients,
    signingDomains: parsed.signingDomains,
  };
}

function validateReply(component: ICAL.Component, event: InvitationEvent) {
  if (
    component.getAllProperties("uid").length !== 1 ||
    component.getAllProperties("sequence").length > 1 ||
    component.getAllProperties("recurrence-id").length > 1 ||
    component.getAllProperties("dtstamp").length !== 1 ||
    event.attendees.length !== 1
  )
    throw new Error("Invalid response");
  const attendee = event.attendees[0];
  const stamp = component.getFirstPropertyValue("dtstamp");
  if (
    !attendee ||
    !["ACCEPTED", "TENTATIVE", "DECLINED"].includes(attendee.partstat) ||
    !(stamp instanceof ICAL.Time) ||
    stamp.isDate ||
    stamp.zone.tzid !== "UTC" ||
    !Number.isSafeInteger(stamp.toUnixTime())
  )
    throw new Error("Invalid response");
  return stamp.toUnixTime();
}
/** Parse an attendee response as data; provenance is verified separately. */
export async function parseInvitationReply(
  raw: Uint8Array,
): Promise<ParsedInvitationReply> {
  const parsed = await parseMessage(raw, "reply");
  const components = parsed.root.getAllSubcomponents("vevent");
  const component = components[0];
  const event = parsed.events[0];
  if (
    components.length !== 1 ||
    parsed.root.getAllProperties("method").length !== 1 ||
    !component ||
    !event
  )
    throw new Error("Invalid response");
  const timestamp = validateReply(component, event);
  return {
    event,
    from: parsed.from,
    signingDomains: parsed.signingDomains,
    recipients: parsed.recipients,
    occurrence: occurrenceKey(component),
    timestamp,
  };
}
