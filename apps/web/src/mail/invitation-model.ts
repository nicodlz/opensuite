import type {
  InvitationAction,
  Message,
  invitationsContract,
} from "@opensuite/contracts";
import { ORPCError } from "@orpc/client";
import type { InferContractRouterOutputs } from "@orpc/contract";
import { recurrenceLabels } from "../calendar/model.ts";
import { isTimeZone, zonedInstant } from "../lib/zoned-time.ts";

type Outputs = InferContractRouterOutputs<typeof invitationsContract>;
export type Invitation = Outputs["read"];
export type InvitationEvent = Invitation["events"][number];
export type OperationResult = Outputs["act"];
export type Choice = InvitationAction["action"];
export type Reply = Exclude<Choice, "apply">;
export type InvitationKind = "new" | "update" | "cancel";

const calendarPart = /^(?:text\/calendar|application\/ics)\s*(?:;|$)/i;
/** Only messages with an iCalendar part can carry an invitation. */
export const mayHaveInvitation = (message: Pick<Message, "attachments">) =>
  message.attachments.some((part) => calendarPart.test(part.type));

/** A later revision (SEQUENCE above 0) of a request is shown as an update. */
export function invitationKind(invitation: Invitation): InvitationKind {
  if (invitation.method === "CANCEL") return "cancel";
  return invitation.events.some((event) => event.sequence > 0)
    ? "update"
    : "new";
}
/** The series itself when present, else the occurrence the message changes. */
export const primaryEvent = (invitation: Invitation) =>
  invitation.events.find((event) => event.recurrenceId === null) ??
  invitation.events[0];
/** A reply names the series, or the single occurrence it was invited to. */
export const replyOccurrence = (invitation: Invitation) =>
  primaryEvent(invitation)?.recurrenceId ?? null;
export const kindLabels: Record<InvitationKind, string> = {
  new: "Invitation",
  update: "Updated invitation",
  cancel: "Cancelled event",
};
export const unverifiedTexts: Record<
  InvitationKind,
  (organizer: string) => string
> = {
  new: (organizer) =>
    `We couldn't confirm that this invitation comes from ${organizer}. Its details and links may be forged. Responding needs an extra confirmation.`,
  update: (organizer) =>
    `We couldn't confirm that this update comes from ${organizer}. Nothing was changed in your calendar, and unverified changes can't update an event that's already there.`,
  cancel: (organizer) =>
    `We couldn't confirm that this cancellation comes from ${organizer}. Nothing was removed from your calendar. If you trust this message, delete the event in Calendar yourself.`,
};
export const participation: Partial<Record<string, string>> = {
  ACCEPTED: "Accepted",
  TENTATIVE: "Tentative",
  DECLINED: "Declined",
  "NEEDS-ACTION": "Awaiting reply",
  DELEGATED: "Delegated",
};

const DAY = 86_400_000;
const dateOnly = /^\d{4}-\d{2}-\d{2}$/;
export const viewerZone = () =>
  Intl.DateTimeFormat().resolvedOptions().timeZone;
/** Calendar-style timing (UTC instants, all-day as UTC midnight), or raw text. */
export type Timing =
  | {
      known: true;
      start: string;
      end: string;
      allDay: boolean;
      zone: string | null;
    }
  | { known: false; text: string };
export type KnownTiming = Extract<Timing, { known: true }>;

/** UTC (`Z`), local to `zone`, or floating time read in the viewer's zone. */
function instantOf(value: string, zone: string | null) {
  if (!value.endsWith("Z")) return zonedInstant(value, zone ?? viewerZone());
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}
function allDayTiming(start: string, end: string | null): Timing {
  const first = Date.parse(`${start}T00:00:00Z`);
  if (Number.isNaN(first)) return { known: false, text: start };
  const last =
    end !== null && dateOnly.test(end)
      ? Date.parse(`${end}T00:00:00Z`)
      : Number.NaN;
  return {
    known: true,
    allDay: true,
    zone: null,
    start: new Date(first).toISOString(),
    end: new Date(last > first ? last : first + DAY).toISOString(),
  };
}
export function eventTiming(
  event: Pick<InvitationEvent, "start" | "end" | "timeZone">,
): Timing | null {
  const { start, end, timeZone } = event;
  if (start === null) return null;
  if (dateOnly.test(start)) return allDayTiming(start, end);
  const from = instantOf(start, timeZone);
  if (from === undefined)
    return {
      known: false,
      text: `${start.slice(0, 16).replace("T", " ")}${timeZone ? ` (${timeZone})` : ""}`,
    };
  const to = end === null ? undefined : instantOf(end, timeZone);
  return {
    known: true,
    allDay: false,
    zone: timeZone,
    start: new Date(from).toISOString(),
    end: new Date(to !== undefined && to > from ? to : from).toISOString(),
  };
}
/** The event's own wall time, when its zone shows a different time from the viewer's. */
export function zoneNote(timing: KnownTiming, viewer = viewerZone()) {
  const zone = timing.zone;
  if (timing.allDay || zone === null || zone === viewer || !isTimeZone(zone))
    return null;
  const at = (timeZone: string) =>
    new Intl.DateTimeFormat(undefined, {
      weekday: "short",
      hour: "numeric",
      minute: "2-digit",
      timeZone,
    }).format(new Date(timing.start));
  const there = at(zone);
  return there === at(viewer) ? null : `${there} in ${zone}`;
}

const frequencies: Partial<Record<string, keyof typeof recurrenceLabels>> = {
  DAILY: "daily",
  WEEKLY: "weekly",
  MONTHLY: "monthly",
  YEARLY: "yearly",
};
export function repeatLabel(rules: string[]) {
  const [rule, ...others] = rules;
  if (rule === undefined) return null;
  const parts = new Map(
    rule
      .toUpperCase()
      .split(";")
      .map((part) => {
        const [name = "", value = ""] = part.split("=");
        return [name, value];
      }),
  );
  const frequency = frequencies[parts.get("FREQ") ?? ""];
  const simple = others.length === 0 && (parts.get("INTERVAL") ?? "1") === "1";
  return frequency && simple
    ? recurrenceLabels[frequency]
    : "Repeats on a custom schedule";
}
/** HTTPS links without credentials; anything else is not offered as a link. */
export function safeLink(value: string | null) {
  if (value === null) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password
      ? url
      : null;
  } catch {
    return null;
  }
}

const definedCodes = [
  "CONFLICT",
  "FORBIDDEN",
  "NOT_FOUND",
  "VALIDATION",
  "TOO_MANY_REQUESTS",
] as const;
/** A defined refusal from the service, or `UNCERTAIN` when the outcome is unknown. */
export type FailureCode = (typeof definedCodes)[number] | "UNCERTAIN";
export function failureCode(error: unknown): FailureCode {
  return error instanceof ORPCError
    ? (definedCodes.find((code) => code === error.code) ?? "UNCERTAIN")
    : "UNCERTAIN";
}

type Tone = "success" | "pending" | "danger";
export type Notice = { tone: Tone; text: string; announce: string };
const notice = (tone: Tone, text: string, announce = text): Notice => ({
  tone,
  text,
  announce,
});
export const replyLabels: Record<Reply, string> = {
  accept: "Accept",
  tentative: "Tentative",
  decline: "Decline",
};
export const replyStates: Record<Reply, string> = {
  accept: "Accepted",
  tentative: "Tentative",
  decline: "Declined",
};
/** What a result from the service means, without claiming more than it says. */
export function resultNotice(
  action: Choice,
  kind: InvitationKind,
  result: OperationResult,
): Notice {
  const { state, eventId } = result;
  const apply = action === "apply";
  if (state === "pending")
    return notice(
      "pending",
      apply
        ? "The calendar change isn't confirmed yet."
        : eventId === null
          ? "Your response isn't confirmed as sent yet."
          : "Your calendar was updated, but sending your response isn't confirmed yet.",
      "Not confirmed yet. Check the status.",
    );
  if (state === "failed")
    return apply
      ? notice("danger", "Your calendar couldn't be updated.")
      : notice(
          "danger",
          eventId === null
            ? "Your response couldn't be sent."
            : "Your calendar was updated, but your response couldn't be sent to the organizer.",
          "Your response couldn't be sent.",
        );
  if (apply)
    return notice(
      "success",
      kind === "cancel"
        ? "The event was removed from your calendar."
        : "Your calendar was updated with these changes.",
    );
  return state === "sent"
    ? notice(
        "success",
        `${replyStates[action]}. Your response was sent to the organizer.`,
        `Response sent: ${replyStates[action]}.`,
      )
    : notice("success", "Your calendar was updated.");
}
type RefusalContext = {
  apply: boolean;
  kind: InvitationKind;
  confirmed: boolean;
};
const refusals: Record<
  Exclude<FailureCode, "UNCERTAIN">,
  (context: RefusalContext) => string
> = {
  CONFLICT: ({ apply }) =>
    apply
      ? "This event changed in Calendar or is in another calendar. Choose the calendar that has it, or reload the invitation."
      : "This invitation changed, or a newer version was already handled. Reload it before responding again.",
  FORBIDDEN: ({ confirmed }) =>
    confirmed
      ? "Changes from an unverified sender can't be applied to an event that's already in your calendar. Ask the organizer to send the invitation again."
      : "You can't respond to this invitation from this account or calendar.",
  NOT_FOUND: ({ apply, kind }) =>
    !apply
      ? "This invitation or calendar is no longer available."
      : kind === "cancel"
        ? "This event isn't in your calendar, so there is nothing to remove."
        : "This event isn't in your calendar yet. Respond to add it.",
  VALIDATION: () => "This invitation can't be answered here.",
  TOO_MANY_REQUESTS: () => "Too many requests. Wait a moment, then try again.",
};
export function failureNotice(
  code: FailureCode,
  action: Choice,
  kind: InvitationKind,
  confirmed: boolean,
): Notice {
  return code === "UNCERTAIN"
    ? notice(
        "pending",
        "We couldn't confirm whether this worked. Check the status before trying again.",
        "Result unknown. Check the status.",
      )
    : notice(
        "danger",
        refusals[code]({ apply: action === "apply", kind, confirmed }),
      );
}

export type Attempt = { input: InvitationAction; confirmed: boolean };
/** The latest response attempt and what the service said about it. */
export type Outcome =
  | { step: "idle" }
  | { step: "working"; attempt: Attempt; checking: boolean }
  | { step: "done"; attempt: Attempt; result: OperationResult }
  | { step: "failed"; attempt: Attempt; code: FailureCode }
  | { step: "unknown"; attempt: Attempt }
  | { step: "unrecorded" };
export function outcomeNotice(
  outcome: Outcome,
  kind: InvitationKind,
): Notice | null {
  if (outcome.step === "idle") return null;
  if (outcome.step === "unrecorded")
    return notice(
      "pending",
      "No response was recorded. You can respond again.",
    );
  if (outcome.step === "unknown")
    return notice(
      "pending",
      "The status is still unknown. Try checking again in a moment.",
    );
  const { action } = outcome.attempt.input;
  if (outcome.step === "done")
    return resultNotice(action, kind, outcome.result);
  if (outcome.step === "failed")
    return failureNotice(outcome.code, action, kind, outcome.attempt.confirmed);
  return notice(
    "pending",
    outcome.checking
      ? "Checking the status…"
      : action === "apply"
        ? "Updating your calendar…"
        : "Sending your response…",
  );
}
/**
 * The request for `action`. Repeating an unsettled identical request keeps
 * its ID, so the service answers it once; anything else is a new request.
 */
export function nextAttempt(
  outcome: Outcome,
  target: Pick<InvitationAction, "accountId" | "messageId" | "calendarId">,
  invitation: Invitation,
  action: Choice,
  confirmed: boolean,
): Attempt {
  const previous =
    outcome.step === "failed" || outcome.step === "unknown"
      ? outcome.attempt
      : null;
  const same =
    previous?.confirmed === confirmed &&
    previous.input.action === action &&
    previous.input.calendarId === target.calendarId;
  return {
    confirmed,
    input: {
      ...target,
      action,
      recurrenceId: action === "apply" ? null : replyOccurrence(invitation),
      requestId: same ? previous.input.requestId : crypto.randomUUID(),
    },
  };
}
/** The operation whose status can still be checked, if any. */
export function checkableOperation(outcome: Outcome) {
  if (outcome.step === "done")
    return outcome.result.state === "pending"
      ? { attempt: outcome.attempt, id: outcome.result.operationId }
      : null;
  return outcome.step === "failed" || outcome.step === "unknown"
    ? { attempt: outcome.attempt, id: outcome.attempt.input.requestId }
    : null;
}
