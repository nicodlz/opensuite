import {
  OrganizerActionSchema,
  type EventContent,
  type OrganizerAction,
  type invitationsContract,
} from "@opensuite/contracts";
import type { InferContractRouterOutputs } from "@orpc/contract";
import { failureCode, participation } from "../mail/invitation-model.ts";

type Outputs = InferContractRouterOutputs<typeof invitationsContract>;
export type OrganizerStatus = Outputs["organizedStatus"];
export type OrganizerResult = Outputs["organize"];
export type CheckedReply = Outputs["processReply"];
/** The service accepts at most this many guests per event. */
export const guestLimit = 100;
const address = OrganizerActionSchema.shape.organizer;

/**
 * Guests typed or pasted into the guest field, separated by commas,
 * semicolons or spaces. Addresses already listed are skipped.
 */
export function parseGuests(text: string, current: string[], self: string) {
  const added: string[] = [];
  for (const part of text.split(/[\s,;]+/).filter(Boolean)) {
    const parsed = address.safeParse(part.replace(/^<|>$/g, "").toLowerCase());
    if (!parsed.success)
      return { added, error: `“${part}” isn't a valid email address.` };
    if (parsed.data === self.toLowerCase())
      return { added, error: "You're the organizer, not a guest." };
    if (!current.includes(parsed.data) && !added.includes(parsed.data))
      added.push(parsed.data);
  }
  if (current.length + added.length > guestLimit)
    return {
      added: [],
      error: `An event can have up to ${String(guestLimit)} guests.`,
    };
  return { added, error: "" };
}

/** Who gets which message when the organizer confirms a change. */
export type InvitationPlan = {
  kind: "create" | "update" | "cancel";
  organizer: string;
  /** Guests invited for the first time (iTIP REQUEST). */
  invite: string[];
  /** Guests who stay and receive the updated event (iTIP REQUEST). */
  update: string[];
  /** Removed guests, or everyone when the event is cancelled (iTIP CANCEL). */
  cancel: string[];
  /** The time or repetition changed, so answers start over. */
  reset: boolean;
  recurring: boolean;
};

/** `before` is null for a new event; the organizer never mails itself. */
export function planInvitations(
  before: string[] | null,
  after: string[],
  options: Pick<InvitationPlan, "organizer" | "reset" | "recurring"> & {
    cancel?: boolean;
  },
): InvitationPlan {
  const { cancel = false, ...rest } = options;
  const others = (list: string[]) =>
    list.filter((item) => item !== options.organizer.toLowerCase());
  const prior = others(before ?? []);
  const next = cancel ? [] : others(after);
  return {
    ...rest,
    kind: cancel ? "cancel" : before === null ? "create" : "update",
    invite: next.filter((item) => !prior.includes(item)),
    update: next.filter((item) => prior.includes(item)),
    cancel: prior.filter((item) => !next.includes(item)),
  };
}

const guests = (count: number) =>
  count === 1 ? "1 guest" : `${String(count)} guests`;
export const recipientsOf = (plan: InvitationPlan) => [
  ...plan.invite,
  ...plan.update,
  ...plan.cancel,
];

/** The groups of messages a confirmation lists, in sending order. */
export function planGroups(plan: InvitationPlan) {
  return [
    { label: "Invitation", recipients: plan.invite },
    { label: "Updated invitation", recipients: plan.update },
    { label: "Cancellation", recipients: plan.cancel },
  ].filter((group) => group.recipients.length > 0);
}

/** Title, explanation and confirm button of the confirmation dialog. */
export function planWording(plan: InvitationPlan) {
  const total = guests(recipientsOf(plan).length);
  if (plan.kind === "cancel")
    return {
      title: "Cancel event for everyone?",
      action: "Cancel event and notify guests",
      notes: [
        `A cancellation goes to ${total}. The event is then removed from your calendar. This can't be undone.`,
      ],
    };
  const notes = [
    `Messages are sent from ${plan.organizer} to ${total}. Esuno hands them to your mail server and can't confirm that they arrive.`,
  ];
  if (plan.kind === "update" && plan.recurring)
    notes.push("Changes apply to every occurrence.");
  if (plan.reset && plan.update.length > 0)
    notes.push(
      "The time or repetition changed, so guests are asked to answer again.",
    );
  return {
    title: plan.kind === "create" ? "Send invitations?" : "Send updates?",
    action: plan.kind === "create" ? "Send invitations" : "Save and send",
    notes,
  };
}

export type Tone = "success" | "pending" | "danger";
export type Notice = { tone: Tone; text: string; details: string[] };
const reasons = {
  sender_unavailable: "your sending address is no longer available",
  submission_rejected: "the mail server refused the message",
} as const;
const messages = {
  create: "Invitations",
  update: "Updates",
  cancel: "Cancellations",
};

/** What a send reported, without claiming that anything was delivered. */
export function resultNotice(
  plan: InvitationPlan,
  result: OrganizerResult,
): Notice {
  if (result.state === "pending" || result.state === "applied")
    return {
      tone: "pending",
      text: "The event is saved, but sending isn't finished yet. Check the status again in a moment.",
      details: [],
    };
  const failed = result.failedRecipients ?? [];
  const handed = recipientsOf(plan).length - failed.length;
  const what = messages[plan.kind];
  const text =
    handed > 0
      ? `${what} handed to your mail server for ${guests(handed)}. Delivery isn't confirmed.`
      : `No ${what.toLowerCase()} could be handed to your mail server.`;
  return {
    tone: failed.length ? "danger" : "success",
    text,
    details: notSent(result),
  };
}
const notSent = (result: OrganizerResult) =>
  (result.failedRecipients ?? []).map(
    (item) => `Not sent to ${item.email}: ${reasons[item.reason]}.`,
  );

/** The outcome of an earlier change, checked from its event's guest list. */
export function checkNotice(result: OrganizerResult): Notice {
  if (result.state === "pending" || result.state === "applied")
    return {
      tone: "pending",
      text: "The earlier change still isn't fully sent. Check again in a moment.",
      details: [],
    };
  const details = notSent(result);
  return details.length
    ? {
        tone: "danger",
        text: "The earlier change was sent, except to these guests:",
        details,
      }
    : {
        tone: "success",
        text: "The earlier change was handed to your mail server. Delivery isn't confirmed.",
        details: [],
      };
}

/** A refusal or an unknown outcome reported by the service. */
export function failureNotice(error: unknown): Notice {
  const code = failureCode(error);
  const refused = {
    CONFLICT:
      "The event changed elsewhere, or an earlier change is still being sent. Nothing was sent. Close this and open the event again.",
    FORBIDDEN:
      "You can't send from this address or change this calendar. Nothing was sent.",
    NOT_FOUND:
      "This event no longer exists or has no invitations. Nothing was sent.",
    VALIDATION:
      "These details can't be sent: events with guests can't have reminders or move to another calendar. Nothing was sent.",
    TOO_MANY_REQUESTS:
      "Too many messages were sent recently. Nothing was sent; try again later.",
  } as const;
  if (code === "UNCERTAIN")
    return {
      tone: "pending",
      text: "Esuno couldn't confirm whether the messages were sent. Trying again is safe: each guest gets this change at most once.",
      details: [],
    };
  return { tone: "danger", text: refused[code], details: [] };
}

/** Whether a failed attempt may be repeated with the same request ID. */
export const isUncertain = (error: unknown) =>
  failureCode(error) === "UNCERTAIN";

export const partstatLabel = (partstat: string) =>
  participation[partstat.toUpperCase()] ?? "Unknown answer";

/** A readable name for an occurrence key of the service, if it is one. */
export function occurrenceLabel(occurrence: string) {
  const [kind = "", value = ""] = occurrence.split(/:(.*)/s);
  const day = { weekday: "short", month: "short", day: "numeric" } as const;
  if (kind === "instant" && /^\d+$/.test(value))
    return new Date(Number(value)).toLocaleString(undefined, {
      ...day,
      hour: "numeric",
      minute: "2-digit",
    });
  if (kind === "date" && /^\d{4}-\d{2}-\d{2}$/.test(value))
    return new Date(`${value}T00:00:00`).toLocaleDateString(undefined, day);
  if (kind === "floating" && !Number.isNaN(Date.parse(value)))
    return new Date(value).toLocaleString(undefined, {
      ...day,
      hour: "numeric",
      minute: "2-digit",
    });
  return occurrence === "master" ? null : occurrence;
}

export type GuestAnswer = {
  /** Answer for the whole series; null when only occurrences were answered. */
  series: string | null;
  occurrences: { label: string; partstat: string }[];
};
/** Answers per guest address, the series first, then single occurrences. */
export function guestAnswers(status: OrganizerStatus) {
  const result = new Map<string, GuestAnswer>();
  for (const item of status.attendees) {
    const entry = result.get(item.email) ?? { series: null, occurrences: [] };
    const label = occurrenceLabel(item.occurrence);
    if (label === null) entry.series = item.partstat;
    else entry.occurrences.push({ label, partstat: item.partstat });
    result.set(item.email, entry);
  }
  return result;
}
export const guestsOf = (status: OrganizerStatus) => [
  ...new Set(status.attendees.map((item) => item.email.toLowerCase())),
];

/** A count per answer, for a short summary that screen readers announce. */
export function answerSummary(answers: Map<string, GuestAnswer>) {
  const counts = new Map<string, number>();
  for (const answer of answers.values()) {
    const label = partstatLabel(answer.series ?? "NEEDS-ACTION");
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts]
    .map(([label, count]) => `${label}: ${String(count)}`)
    .join(", ");
}

const scheduleFields = ["start", "end", "allDay", "recurrence"] as const;
/** Guests answer again when the time or repetition changes. */
export const changesSchedule = (before: EventContent, after: EventContent) =>
  scheduleFields.some((field) => before[field] !== after[field]);
const fields = [
  ...scheduleFields,
  "title",
  "description",
  "location",
  "calendarId",
  "timeZone",
] as const;
export const sameContent = (before: EventContent, after: EventContent) =>
  fields.every((field) => before[field] === after[field]);
export const sameGuests = (before: string[], after: string[]) =>
  before.length === after.length &&
  before.every((item) => after.includes(item));

/** What the dialog sends; the request ID is chosen when it is sent. */
export type InvitationRequest = {
  plan: InvitationPlan;
  input: Omit<OrganizerAction, "requestId">;
  /** Shown in the dialog: the event's title. */
  title: string;
};

/** Messages about guest replies that could not be counted. */
export const replyResults: Record<CheckedReply["result"], string> = {
  applied: "Counted in the guest list.",
  pending: "Counted once the current change has been sent.",
  unverified: "Not counted: Esuno couldn't confirm who sent it.",
  stale: "Not counted: it answers an earlier version of the event.",
  duplicate: "Already counted.",
  conflict: "Not counted: it doesn't match a current guest or occurrence.",
};
