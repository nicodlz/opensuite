import {
  invitationsContract,
  type EventContent,
  type OrganizerAction,
  type mailContract,
} from "@opensuite/contracts";
import type {
  ContractRouterClient,
  InferContractRouterOutputs,
} from "@orpc/contract";
import { implement } from "@orpc/server";
import { fakeAddresses } from "./addresses.ts";
import {
  calendarText,
  guardOrganized,
  mailCalendar,
  organizerCalendar,
} from "./calendar.ts";

/*
 * The local organizer service of the development server. Like the API it
 * checks the sending address, writes the organizer's event, hands one iTIP
 * message per guest to the synthetic mailbox (they show in Sent, from the
 * mailbox's own address) and follows the replies. Nothing leaves the browser.
 *
 * Synthetic guests answer one minute after an invitation:
 * sam@studio.example.test accepts (and declines next week's occurrence of a
 * weekly event), ana@partner.example.test declines and
 * lena@studio.example.test is tentative. Replies from unverified.example.test
 * come from a sender that cannot be verified; the mail server refuses
 * messages to bounce.example.test. `organizer-fixture-outcome` changes every
 * send while set: "uncertain" (written, then the service stops answering),
 * "pending", "conflict", "forbidden" or "sender-revoked".
 * `organizer-fixture-status` = "unavailable" makes guest lists and the list
 * of unverified answers unreadable.
 */
type Outputs = InferContractRouterOutputs<typeof invitationsContract>;
type Result = Outputs["organize"];
type Failure = NonNullable<Result["failedRecipients"]>[number];
type ReplyResult = Outputs["processReply"]["result"];
type InvitationEvent = Outputs["read"]["events"][number];
type MailClient = ContractRouterClient<typeof mailContract>;

type Series = {
  id: string;
  uid: string;
  calendarId: string;
  organizer: string;
  sequence: number;
  cancelled: boolean;
  pendingId: string | null;
  attendees: string[];
  content: EventContent;
  /** Answers per guest, then per occurrence ("master" is the series). */
  answers: Map<string, Map<string, string>>;
};
type Reply = {
  messageId: string;
  seriesId: string;
  attendee: string;
  partstat: string;
  occurrence: string;
  sequence: number;
  at: number;
  verified: boolean;
  result?: ReplyResult;
};
type Operation = {
  fingerprint: string;
  result: Result;
  finish?: () => Promise<Result>;
};
type State = {
  account: string;
  mail: MailClient;
  series: Map<string, Series>;
  operations: Map<string, Operation>;
  replies: Reply[];
};
const api = implement(invitationsContract);
type Errors = Parameters<
  Parameters<typeof api.organize.handler>[0]
>[0]["errors"];

const accountId = "default";
const replyDelay = 60_000;
const answers: Partial<Record<string, string>> = {
  "sam@studio.example.test": "ACCEPTED",
  "ana@partner.example.test": "DECLINED",
  "lena@studio.example.test": "TENTATIVE",
};
const flag = () => sessionStorage.getItem("organizer-fixture-outcome");
const domainOf = (email: string) => email.slice(email.lastIndexOf("@") + 1);
const seriesOf = (eventId: string) => eventId.split("~")[0] ?? eventId;
const stamp = (iso: string, allDay: boolean) =>
  allDay ? iso.slice(0, 10) : iso.replace(/\.\d+Z$/, "Z");

/** The next week's occurrence of a weekly event, as the API names it. */
function nextWeek({ recurrence, allDay, start }: EventContent) {
  if (recurrence !== "weekly" || allDay) return undefined;
  const date = new Date(start);
  date.setDate(date.getDate() + 7);
  return `instant:${String(date.getTime())}`;
}

function invitationEvent(
  series: Series,
  attendee: string,
  partstat = "NEEDS-ACTION",
): InvitationEvent {
  const { content } = series;
  return {
    uid: series.uid,
    recurrenceId: null,
    recurrenceIdTimeZone: null,
    sequence: series.sequence,
    organizer: { email: series.organizer, name: null },
    attendees: [{ email: attendee, name: null, partstat }],
    title: content.title,
    description: content.description,
    location: content.location,
    start: stamp(content.start, content.allDay),
    end: stamp(content.end, content.allDay),
    timeZone: null,
    recurrence:
      content.recurrence === "none"
        ? []
        : [`FREQ=${content.recurrence.toUpperCase()}`],
    meetingUrl: null,
  };
}

/** The mailbox's own address or one of its ready addresses, as the API checks. */
async function mayUse(state: State, organizer: string) {
  if (organizer === state.account) return true;
  const { addresses } = await fakeAddresses.list({});
  return addresses.some(
    (row) => row.ready && row.address.toLowerCase() === organizer,
  );
}

/** The series an update or cancellation changes, refused like the API. */
async function target(state: State, input: OrganizerAction, errors: Errors) {
  const { calendars } = await organizerCalendar.calendars({ accountId });
  if (!calendars.some((item) => item.id === input.event.calendarId))
    throw errors.NOT_FOUND();
  const reminder = input.event.reminder ?? "none";
  if (input.eventId === null) {
    if (input.cancel || reminder !== "none") throw errors.VALIDATION();
    return undefined;
  }
  const prior = state.series.get(seriesOf(input.eventId));
  if (!prior) throw errors.NOT_FOUND();
  if (
    prior.pendingId ||
    prior.cancelled ||
    prior.organizer !== input.organizer.toLowerCase() ||
    prior.calendarId !== input.event.calendarId
  )
    throw errors.CONFLICT();
  if (reminder !== (prior.content.reminder ?? "none"))
    throw errors.VALIDATION();
  return prior;
}

const timing = (content: EventContent) =>
  [content.start, content.end, content.allDay, content.recurrence].join();
/** Writes the organizer's version; a new time or repetition resets answers. */
async function write(input: OrganizerAction, prior: Series | undefined) {
  if (prior && input.cancel) return prior;
  const request = { accountId, event: input.event };
  const written = prior
    ? await organizerCalendar.updateEvent({
        ...request,
        eventId: input.eventId ?? prior.id,
      })
    : await organizerCalendar.createEvent(request);
  const content = { ...input.event, start: written.start, end: written.end };
  const series: Series = prior ?? {
    id: written.seriesId,
    uid: `${crypto.randomUUID()}@esuno.local`,
    calendarId: input.event.calendarId,
    organizer: input.organizer.toLowerCase(),
    sequence: -1,
    cancelled: false,
    pendingId: null,
    attendees: [],
    content,
    answers: new Map(),
  };
  if (timing(series.content) !== timing(content)) series.answers.clear();
  series.content = content;
  return series;
}

/** Queues the synthetic guests' replies to a request. */
function expectReplies(state: State, series: Series, attendee: string) {
  const verified = domainOf(attendee) !== "unverified.example.test";
  const partstat = verified ? answers[attendee] : "ACCEPTED";
  if (!partstat) return;
  const reply = (occurrence: string, value: string) =>
    state.replies.push({
      messageId: `reply-${crypto.randomUUID()}`,
      seriesId: series.id,
      attendee,
      partstat: value,
      occurrence,
      sequence: series.sequence,
      at: Date.now() + replyDelay,
      verified,
    });
  reply("master", partstat);
  const second = nextWeek(series.content);
  if (second && attendee === "sam@studio.example.test")
    reply(second, "DECLINED");
}

function rejection(recipient: string): Failure["reason"] | null {
  if (flag() === "sender-revoked") return "sender_unavailable";
  return domainOf(recipient) === "bounce.example.test"
    ? "submission_rejected"
    : null;
}

/** Sends every message of a reserved change, then releases its series. */
async function deliver(
  state: State,
  series: Series,
  deliveries: [string, "REQUEST" | "CANCEL"][],
  operationId: string,
): Promise<Result> {
  const failed: Failure[] = [];
  await Promise.all(
    deliveries.map(async ([recipient, method]) => {
      const reason = rejection(recipient);
      if (reason) {
        failed.push({ email: recipient, reason });
        return;
      }
      const subject = `Calendar ${method === "CANCEL" ? "cancellation" : "invitation"}`;
      const event = invitationEvent(series, recipient);
      await mailCalendar(state.mail, recipient, subject, [
        "invite.ics",
        calendarText(method, event),
      ]);
      if (method === "REQUEST") expectReplies(state, series, recipient);
    }),
  );
  series.pendingId = null;
  return {
    operationId,
    state: failed.length ? "failed" : "sent",
    eventId: series.id,
    ...(failed.length ? { failedRecipients: failed } : {}),
  };
}

/** REQUEST to every guest, CANCEL to removed guests or all on cancellation. */
function reserve(series: Series, input: OrganizerAction) {
  const before = series.attendees;
  const after = input.cancel
    ? []
    : input.attendees.map((item) => item.toLowerCase());
  const deliveries: [string, "REQUEST" | "CANCEL"][] = [
    ...after
      .filter((item) => item !== series.organizer)
      .map((item): [string, "REQUEST"] => [item, "REQUEST"]),
    ...before
      .filter((item) => !after.includes(item) && item !== series.organizer)
      .map((item): [string, "CANCEL"] => [item, "CANCEL"]),
  ];
  for (const removed of before.filter((item) => !after.includes(item)))
    series.answers.delete(removed);
  if (!input.cancel) series.attendees = after;
  series.cancelled = input.cancel;
  series.sequence += 1;
  series.pendingId = input.requestId;
  return deliveries;
}

async function organize(
  state: State,
  input: OrganizerAction,
  errors: Errors,
): Promise<Result> {
  const fingerprint = JSON.stringify(input);
  const known = state.operations.get(input.requestId);
  if (known && known.fingerprint !== fingerprint) throw errors.CONFLICT();
  if (known) return known.finish ? known.finish() : known.result;
  const outcome = flag();
  if (outcome === "conflict") throw errors.CONFLICT();
  const organizer = input.organizer.toLowerCase();
  const attendees = input.attendees.map((item) => item.toLowerCase());
  if (new Set(attendees).size !== attendees.length) throw errors.VALIDATION();
  if (outcome === "forbidden" || !(await mayUse(state, organizer)))
    throw errors.FORBIDDEN();
  const series = await write(input, await target(state, input, errors));
  state.series.set(series.id, series);
  const deliveries = reserve(series, input);
  const operation: Operation = {
    fingerprint,
    result: {
      operationId: input.requestId,
      state: "pending",
      eventId: series.id,
    },
  };
  state.operations.set(input.requestId, operation);
  const finish = async () => {
    delete operation.finish;
    operation.result = await deliver(
      state,
      series,
      deliveries,
      input.requestId,
    );
    return operation.result;
  };
  if (outcome !== "uncertain" && outcome !== "pending") return finish();
  operation.finish = finish;
  if (outcome === "uncertain") throw errors.UPSTREAM_UNAVAILABLE();
  return operation.result;
}

function count(series: Series, reply: Reply): ReplyResult {
  if (series.cancelled || !series.attendees.includes(reply.attendee))
    return "conflict";
  if (reply.sequence < series.sequence) return "stale";
  if (series.pendingId) return "pending";
  const given = series.answers.get(reply.attendee) ?? new Map<string, string>();
  const duplicate = given.get(reply.occurrence) === reply.partstat;
  given.set(reply.occurrence, reply.partstat);
  series.answers.set(reply.attendee, given);
  return duplicate ? "duplicate" : "applied";
}
/**
 * Replies that have arrived, verified ones counted as the scan worker does
 * once no change of their series is still being sent.
 */
function arrived(state: State) {
  const now = Date.now();
  for (const reply of state.replies) {
    const series = state.series.get(reply.seriesId);
    if (reply.at <= now && !reply.result && series && !series.pendingId)
      reply.result = reply.verified ? count(series, reply) : "unverified";
  }
  return state.replies.filter((reply) => reply.result);
}

const unreadable = (errors: Errors) => {
  if (sessionStorage.getItem("organizer-fixture-status") === "unavailable")
    throw errors.UPSTREAM_UNAVAILABLE();
};
function status(state: State, eventId: string, errors: Errors) {
  unreadable(errors);
  arrived(state);
  const series = state.series.get(seriesOf(eventId));
  if (!series) throw errors.NOT_FOUND();
  return {
    organizer: series.organizer,
    sequence: series.sequence,
    cancelled: series.cancelled,
    pendingOperationId: series.pendingId,
    attendees: series.attendees.flatMap((email) => {
      const given = [...(series.answers.get(email) ?? [])];
      return given.length
        ? given.map(([occurrence, partstat]) => ({
            email,
            partstat,
            occurrence,
          }))
        : [{ email, partstat: "NEEDS-ACTION", occurrence: "master" }];
    }),
  };
}

function processReply(state: State, messageId: string, errors: Errors) {
  const reply = arrived(state).find((item) => item.messageId === messageId);
  const series = reply && state.series.get(reply.seriesId);
  if (!reply || !series) throw errors.NOT_FOUND();
  return {
    senderStatus: reply.verified
      ? ("verified" as const)
      : ("unverified" as const),
    verificationPending: false,
    event: invitationEvent(series, reply.attendee, reply.partstat),
    from: [reply.attendee],
    occurrence: reply.occurrence,
    result: reply.verified ? count(series, reply) : ("unverified" as const),
  };
}

const own = (input: { accountId: string }, errors: Errors) => {
  if (input.accountId !== accountId) throw errors.FORBIDDEN();
};
/** Organizer procedures of one synthetic mailbox, with its own memory. */
export function organizerHandlers(account: string, mail: MailClient) {
  const state: State = {
    account: account.toLowerCase(),
    mail,
    series: new Map(),
    operations: new Map(),
    replies: [],
  };
  guardOrganized((seriesId) => {
    const series = state.series.get(seriesId);
    if (!series) return undefined;
    return series.cancelled && !series.pendingId ? "cancelled" : "organized";
  });
  return {
    organize: api.organize.handler(({ input, errors }) => {
      own(input, errors);
      return organize(state, input, errors);
    }),
    organizedStatus: api.organizedStatus.handler(({ input, errors }) => {
      own(input, errors);
      return status(state, input.eventId, errors);
    }),
    unverifiedReplies: api.unverifiedReplies.handler(({ input, errors }) => {
      own(input, errors);
      unreadable(errors);
      const ids = arrived(state)
        .filter((reply) => reply.result === "unverified")
        .map((reply) => reply.messageId);
      const from = input.cursor ? ids.indexOf(input.cursor) + 1 : 0;
      const page = ids.slice(from, from + 100);
      const more = ids.length > from + 100;
      return {
        messageIds: page,
        nextCursor: more ? (page.at(-1) ?? null) : null,
      };
    }),
    processReply: api.processReply.handler(({ input, errors }) => {
      own(input, errors);
      return processReply(state, input.messageId, errors);
    }),
    reconcileOrganized: api.reconcileOrganized.handler(({ input, errors }) => {
      own(input, errors);
      const operation = state.operations.get(input.operationId);
      if (!operation) throw errors.NOT_FOUND();
      return operation.finish ? operation.finish() : operation.result;
    }),
  };
}
