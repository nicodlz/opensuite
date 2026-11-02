import { ORPCError } from "@orpc/client";

export type Problem =
  | "offline"
  | "session"
  | "denied"
  | "missing"
  | "target"
  | "conflict"
  | "busy"
  | "invalid"
  | "tooLarge"
  | "unavailable"
  | "unknown";
/** A request the client does not send because the API would refuse its size. */
export class RequestTooLarge extends Error {}
const problemCodes: Record<string, Problem> = {
  UNAUTHORIZED: "session",
  FORBIDDEN: "denied",
  NOT_FOUND: "missing",
  TARGET_NOT_FOUND: "target",
  CONFLICT: "conflict",
  TOO_MANY_REQUESTS: "busy",
  VALIDATION: "invalid",
  BAD_REQUEST: "invalid",
  PAYLOAD_TOO_LARGE: "tooLarge",
  UPSTREAM_UNAVAILABLE: "unavailable",
  SERVICE_UNAVAILABLE: "unavailable",
};
const problemStatuses: Record<number, Problem> = {
  401: "session",
  413: "tooLarge",
};
/** A request that never got an answer is a lost connection, not a refusal. */
export function problemOf(error: unknown, online: boolean): Problem {
  if (error instanceof RequestTooLarge) return "tooLarge";
  if (!online || error instanceof TypeError) return "offline";
  if (!(error instanceof ORPCError)) return "unknown";
  const code: unknown = error.code;
  const known = typeof code === "string" ? problemCodes[code] : undefined;
  return known ?? problemStatuses[error.status] ?? "unknown";
}
/** Where the problem happened, which changes what the user should do. */
export type ProblemContext =
  "load" | "start" | "preview" | "action" | "calendar";
const shared: Record<Problem, string> = {
  offline:
    "You’re offline. Migrations already running continue on the server; reconnect and try again.",
  session: "Your session has ended. Sign in again to continue.",
  denied: "You don’t have access to migrations for this account.",
  missing: "This migration doesn’t exist or isn’t available to your account.",
  target:
    "The destination calendar no longer exists. Choose another calendar or cancel the import.",
  conflict:
    "This migration changed in the meantime. The latest state is shown.",
  busy: "Too many requests. Wait a minute, then try again.",
  invalid: "This action isn’t possible in the migration’s current state.",
  tooLarge:
    "This request is too large for the server. Choose fewer or smaller files.",
  unavailable: "The migration service is unavailable. Try again later.",
  unknown: "Something went wrong. Try again.",
};
const unconfirmed =
  "Check your migrations before trying again: it may have been created.";
const specific: Record<ProblemContext, Partial<Record<Problem, string>>> = {
  load: {},
  action: {},
  start: {
    offline: `You’re offline, so the start of this migration could not be confirmed. ${unconfirmed}`,
    conflict:
      "Another import is already in progress. Wait for it to finish or cancel it first.",
    invalid:
      "The server refused these settings. Check the destination mailbox, the label mappings and the limits.",
    unavailable: `The migration service is unavailable, so the start could not be confirmed. ${unconfirmed}`,
    unknown: `The start of this migration could not be confirmed. ${unconfirmed}`,
  },
  preview: {
    offline: `You’re offline, so the preview could not be confirmed. ${unconfirmed}`,
    busy: "The server refused a new calendar preview: either several were requested within a minute, or the maximum number of calendar imports is already kept. Wait a minute, or remove finished calendar imports under Migration.",
    invalid:
      "The server refused these files. Check that they are valid ICS calendars within the limits.",
    tooLarge:
      "These files are too large to preview together. Import them in smaller batches.",
    unknown: `The preview could not be confirmed. ${unconfirmed}`,
  },
  calendar: {
    offline:
      "You’re offline. This calendar import is paused; continue it once you’re back online.",
  },
};
export function problemMessage(problem: Problem, context: ProblemContext) {
  return specific[context][problem] ?? shared[problem];
}
