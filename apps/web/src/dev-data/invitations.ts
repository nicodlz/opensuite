import {
  RecurrenceSchema,
  invitationsContract,
  type InvitationAction,
  type Message,
  type mailContract,
} from "@opensuite/contracts";
import type {
  ContractRouterClient,
  InferContractRouterOutputs,
} from "@orpc/contract";
import { implement } from "@orpc/server";
import { zonedInstant } from "../lib/zoned-time.ts";
import { calendarText, fakeCalendarClient, mailCalendar } from "./calendar.ts";
import { organizerHandlers } from "./invitation-organizer.ts";

export { base64 } from "./calendar.ts";

/*
 * Synthetic calendar invitations for the development server, modelled on
 * Google Calendar messages with Google Meet links. They join the synthetic
 * inbox only when sessionStorage has `mail-fixture-invitations` set to "1" at
 * start-up. `invitation-fixture-outcome` changes the next response:
 * "uncertain" (written, then the service stops answering and the reply waits
 * for a status check), "failed" or "conflict". `invitation-fixture-fail-read`
 * = "1" makes reading fail.
 */
type Outputs = InferContractRouterOutputs<typeof invitationsContract>;
type Invitation = Outputs["read"];
type InvitationEvent = Invitation["events"][number];
type OperationResult = Outputs["act"];
type Account = Message["from"];
type MailClient = ContractRouterClient<typeof mailContract>;
/** An invitation message of the synthetic mailbox and its iCalendar part. */
export type InvitationFixture = {
  id: string;
  subject: string;
  from: { email: string; name: string };
  intro: string;
  invitation: Invitation;
  sentAt: string;
  calendar: string;
};
const accountId = "default";
const localZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const now = new Date();
const pad = (value: number) => String(value).padStart(2, "0");
/** Local time on day `day` of next week (0 is Monday), as the API returns it. */
function wall(day: number, hour: number, minute = 0) {
  const date = new Date(now);
  date.setDate(date.getDate() + 7 - ((date.getDay() + 6) % 7) + day);
  const ymd = `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}`;
  return `${ymd}-${pad(date.getDate())}T${pad(hour)}:${pad(minute)}:00`;
}
const meet = "https://meet.google.com/abc-defg-hij";
const lena = { email: "lena@studio.example.test", name: "Lena Ortiz" };
const payroll = { email: "payroll@hr-portal.example.test", name: "Payroll" };
const people = (you: Account, organizer: typeof lena) => [
  { ...organizer, partstat: "ACCEPTED" },
  { email: you.email, name: you.name ?? null, partstat: "NEEDS-ACTION" },
];

const guest = (email: string, name: string, partstat: string) => ({
  email,
  name,
  partstat,
});

function syncEvent(you: Account): InvitationEvent {
  return {
    uid: "6pq3sync0@google.com",
    recurrenceId: null,
    recurrenceIdTimeZone: null,
    sequence: 0,
    organizer: lena,
    attendees: [
      ...people(you, lena),
      guest("sam@studio.example.test", "Sam Okafor", "TENTATIVE"),
      guest("ana@partner.example.test", "Ana Silva", "DECLINED"),
    ],
    title: "Product sync",
    description: `Weekly check-in on the launch plan.\n\nJoin with Google Meet: ${meet}\nOr dial: (US) +1 555-0100 PIN: 123 456#\n\nInvitation from Google Calendar`,
    location: "Studio, Room 4B",
    start: wall(3, 10),
    end: wall(3, 10, 30),
    timeZone: "America/New_York",
    recurrence: [],
    meetingUrl: meet,
  };
}
const variant = (
  event: InvitationEvent,
  sequence: number,
  [start, end]: [string, string],
  change: Partial<InvitationEvent> = {},
): InvitationEvent => ({ ...event, ...change, sequence, start, end });

/** Google Calendar style requests, updates and cancellations, verified or not. */
function fixturesFor(you: Account): InvitationFixture[] {
  const sync = syncEvent(you);
  const moved = variant(sync, 1, [wall(4, 11), wall(4, 11, 45)], {
    location: "Studio loft, 3rd floor",
  });
  const review = variant(sync, 0, [wall(1, 9), wall(1, 9, 30)], {
    uid: "payroll-review-77@hr-portal.example.test",
    organizer: payroll,
    attendees: people(you, payroll),
    title: "Payroll access review",
    description: "Bring your employee number. Join from the link below.",
    location: "Online",
    timeZone: "Europe/London",
    recurrence: ["FREQ=WEEKLY;BYDAY=TU"],
    meetingUrl: "https://meet.google.com.hr-portal.example.test/review",
  });
  const spoofed = variant(moved, 3, [wall(4, 18), wall(4, 19)], {
    meetingUrl: "https://meet-google.example.test/prd-sync",
  });
  const fixture = (
    id: string,
    subject: string,
    method: Invitation["method"],
    event: InvitationEvent,
    senderStatus: Invitation["senderStatus"] = "verified",
  ): Omit<InvitationFixture, "sentAt"> => ({
    id,
    subject,
    from: event.organizer.email === payroll.email ? payroll : lena,
    intro: `${subject}. Sent from Google Calendar.`,
    invitation: { method, senderStatus, events: [event] },
    calendar: calendarText(method, event),
  });
  const product = "Product sync";
  return [
    fixture("inv-request", `Invitation: ${product}`, "REQUEST", sync),
    fixture("inv-update", `Updated invitation: ${product}`, "REQUEST", moved),
    fixture("inv-cancel", `Canceled event: ${product}`, "CANCEL", {
      ...moved,
      sequence: 2,
    }),
    fixture(
      "inv-unverified",
      "Invitation: Payroll access review",
      "REQUEST",
      review,
      "unverified",
    ),
    fixture(
      "inv-unverified-update",
      `Updated invitation: ${product} (new link)`,
      "REQUEST",
      spoofed,
      "unverified",
    ),
    fixture(
      "inv-unverified-cancel",
      `Canceled event with note: ${product}`,
      "CANCEL",
      { ...moved, sequence: 4 },
      "unverified",
    ),
  ].map((item, index) =>
    Object.assign(item, {
      sentAt: new Date(now.getTime() - (index + 1) * 3_600_000).toISOString(),
    }),
  );
}

// What the local service remembers per series and per request, like the API.
type Series = {
  calendarId: string;
  eventId: string;
  sequence: number;
  cancelled: boolean;
  pending: boolean;
};
type Operation = {
  fingerprint: string;
  result: OperationResult;
  finish?: () => Promise<OperationResult>;
};
type Service = {
  fixtures: InvitationFixture[];
  account: Account;
  mail: MailClient;
  series: Map<string, Series>;
  operations: Map<string, Operation>;
};
const partstats = {
  accept: "ACCEPTED",
  tentative: "TENTATIVE",
  decline: "DECLINED",
} as const;
const api = implement(invitationsContract);
type Errors = Parameters<Parameters<typeof api.act.handler>[0]>[0]["errors"];
const outcomeFlag = () => sessionStorage.getItem("invitation-fixture-outcome");

/** Writes the organizer's version to the synthetic calendar, as the service does. */
async function writeCalendar(
  event: InvitationEvent,
  calendarId: string,
  prior: Series | undefined,
  errors: Errors,
) {
  const zone = event.timeZone ?? localZone;
  const [start, end] = [event.start, event.end].map((value) => {
    const found = value === null ? undefined : zonedInstant(value, zone);
    if (found === undefined) throw errors.VALIDATION();
    return new Date(found).toISOString();
  });
  const frequency = /FREQ=([A-Z]+)/.exec(event.recurrence[0] ?? "")?.[1];
  const content = {
    calendarId,
    title: event.title,
    description: event.description,
    location: event.location,
    start: start ?? "",
    end: end ?? "",
    allDay: false,
    timeZone: zone,
    recurrence: RecurrenceSchema.catch("none").parse(frequency?.toLowerCase()),
  };
  const write = { accountId, event: content };
  const written = prior
    ? await fakeCalendarClient.updateEvent({ ...write, eventId: prior.eventId })
    : await fakeCalendarClient.createEvent(write);
  return written.seriesId;
}
const refusesUnverified = (
  confirmed: boolean,
  invitation: Invitation,
  reply: string | undefined,
  prior: Series | undefined,
) =>
  invitation.senderStatus === "unverified" &&
  !(confirmed && invitation.method === "REQUEST" && reply && !prior);
const isStale = (prior: Series, input: InvitationAction, sequence: number) =>
  prior.calendarId !== input.calendarId ||
  prior.pending ||
  prior.cancelled ||
  sequence < prior.sequence;
async function target(
  service: Service,
  input: InvitationAction,
  errors: Errors,
) {
  const { invitation } =
    service.fixtures.find((item) => item.id === input.messageId) ?? {};
  const event = invitation?.events[0];
  const { calendars } = await fakeCalendarClient.calendars({ accountId });
  const known = calendars.some((item) => item.id === input.calendarId);
  if (!invitation || !event || !known) throw errors.NOT_FOUND();
  return { invitation, event };
}
/** The same refusals as the API: unknown items, rights, method, sender and state. */
async function admit(
  service: Service,
  input: InvitationAction,
  confirmed: boolean,
  errors: Errors,
) {
  const { invitation, event } = await target(service, input, errors);
  const own = service.account.email;
  if ((input.recipient ?? own) !== own) throw errors.FORBIDDEN();
  const reply = input.action === "apply" ? undefined : partstats[input.action];
  if (invitation.method === "CANCEL" && reply) throw errors.VALIDATION();
  const prior = service.series.get(event.uid);
  // Only a new request can be answered after confirming an unverified sender.
  if (refusesUnverified(confirmed, invitation, reply, prior))
    throw errors.FORBIDDEN();
  if (!prior && !reply) throw errors.NOT_FOUND();
  if (
    (prior && isStale(prior, input, event.sequence)) ||
    outcomeFlag() === "conflict"
  )
    throw errors.CONFLICT();
  return { event, reply, prior, method: invitation.method };
}

type Recorder = (
  state: OperationResult["state"],
  finish?: () => Promise<OperationResult>,
) => OperationResult;
/** Sends the reply now, after a status check, or reports it as failed. */
async function answer(
  service: Service,
  reply: { event: InvitationEvent; partstat: string; series: Series },
  record: Recorder,
  errors: Errors,
) {
  const flag = outcomeFlag();
  const send = () =>
    mailCalendar(
      service.mail,
      reply.event.organizer.email,
      `Invitation response: ${reply.partstat.toLowerCase()}`,
      ["reply.ics", calendarText("REPLY", reply.event, reply.partstat)],
    );
  if (flag === "failed") return record("failed");
  if (flag !== "uncertain") {
    await send();
    return record("sent");
  }
  reply.series.pending = true;
  record("pending", async () => {
    await send();
    reply.series.pending = false;
    return record("sent");
  });
  throw errors.UPSTREAM_UNAVAILABLE();
}

async function perform(
  service: Service,
  input: InvitationAction,
  confirmed: boolean,
  errors: Errors,
) {
  const fingerprint = JSON.stringify([input, confirmed]);
  const previous = service.operations.get(input.requestId);
  if (previous && previous.fingerprint !== fingerprint) throw errors.CONFLICT();
  if (previous) return previous.result;
  const checked = await admit(service, input, confirmed, errors);
  const { event, reply, prior, method } = checked;
  const eventId =
    method === "CANCEL" && prior
      ? prior.eventId
      : await writeCalendar(event, input.calendarId, prior, errors);
  if (method === "CANCEL")
    await fakeCalendarClient.deleteEvent({ accountId, eventId });
  const series = {
    calendarId: input.calendarId,
    eventId,
    sequence: event.sequence,
    cancelled: method === "CANCEL",
    pending: false,
  };
  service.series.set(event.uid, series);
  const record: Recorder = (state, finish) => {
    const result = { operationId: input.requestId, state, eventId };
    const operation = { fingerprint, result, ...(finish ? { finish } : {}) };
    service.operations.set(input.requestId, operation);
    return result;
  };
  return reply
    ? answer(service, { event, partstat: reply, series }, record, errors)
    : record("applied");
}

const failRead = () =>
  sessionStorage.getItem("invitation-fixture-fail-read") === "1";
function routerFor(service: Service) {
  // Each synthetic mailbox has its own series and requests.
  return api.router({
    ...organizerHandlers(service.account.email, service.mail),
    read: api.read.handler(({ input, errors }) => {
      const found = service.fixtures.find(
        (item) => item.id === input.messageId,
      );
      if (!found) throw errors.NOT_FOUND();
      if (failRead()) throw errors.UPSTREAM_UNAVAILABLE();
      return found.invitation;
    }),
    act: api.act.handler(({ input, errors }) =>
      perform(service, input, false, errors),
    ),
    confirm: api.confirm.handler(({ input, errors }) =>
      perform(service, input, true, errors),
    ),
    reconcile: api.reconcile.handler(async ({ input, errors }) => {
      const operation = service.operations.get(input.operationId);
      if (!operation) throw errors.NOT_FOUND();
      return operation.finish ? operation.finish() : operation.result;
    }),
  });
}

/** Invitation fixtures for the synthetic mailbox, and the local invitation service. */
export function syntheticInvitations(account: Account) {
  const fixtures = fixturesFor(account);
  const shown = sessionStorage.getItem("mail-fixture-invitations") === "1";
  const memory = { series: new Map(), operations: new Map() };
  return {
    fixtures: shown ? fixtures : [],
    router: (mail: MailClient) =>
      routerFor({ fixtures, account, mail, ...memory }),
  };
}
