import { oc } from "@orpc/contract";
import { z } from "zod";
import { IdSchema } from "./mail.ts";
import { EventContentSchema } from "./calendar.ts";

const person = z.object({ email: z.email(), name: z.string().nullable() });
export const InvitationEventSchema = z.object({
  uid: z.string(),
  recurrenceId: z.string().nullable(),
  recurrenceIdTimeZone: z.string().nullable(),
  sequence: z.number().int().nonnegative(),
  organizer: person,
  attendees: z.array(person.extend({ partstat: z.string() })),
  title: z.string(),
  description: z.string(),
  location: z.string(),
  start: z.string().nullable(),
  end: z.string().nullable(),
  timeZone: z.string().nullable(),
  recurrence: z.array(z.string()),
  meetingUrl: z.url().nullable(),
});
export const InvitationSchema = z.object({
  method: z.enum(["REQUEST", "CANCEL"]),
  senderStatus: z.enum(["verified", "unverified"]),
  events: z.array(InvitationEventSchema),
});
const procedure = oc.errors({
  NOT_FOUND: { status: 404, message: "Invitation not found" },
  FORBIDDEN: { status: 403, message: "Access denied" },
  VALIDATION: { status: 400, message: "Invalid invitation" },
  CONFLICT: { status: 409, message: "Invitation changed" },
  TOO_MANY_REQUESTS: { status: 429, message: "Too many requests" },
  UPSTREAM_UNAVAILABLE: {
    status: 503,
    message: "Invitation service unavailable",
  },
});
export const InvitationActionSchema = z.object({
  accountId: IdSchema,
  messageId: IdSchema,
  calendarId: IdSchema,
  requestId: z.uuid(),
  action: z.enum(["accept", "tentative", "decline", "apply"]),
  recurrenceId: z.string().max(128).nullable(),
  recipient: z.email().optional(),
});
export type InvitationAction = z.infer<typeof InvitationActionSchema>;
const InvitationResultSchema = z.object({
  operationId: z.uuid(),
  state: z.enum(["pending", "sent", "applied", "failed"]),
  eventId: IdSchema.nullable(),
});

export const OrganizerActionSchema = z.object({
  accountId: IdSchema,
  requestId: z.uuid(),
  eventId: IdSchema.nullable(),
  organizer: z.email().max(320),
  attendees: z.array(z.email().max(320)).max(100),
  event: EventContentSchema,
  cancel: z.boolean(),
});
export type OrganizerAction = z.infer<typeof OrganizerActionSchema>;

export const invitationsContract = {
  organize: procedure
    .route({ method: "POST", path: "/invitations/organize" })
    .input(OrganizerActionSchema)
    .output(InvitationResultSchema),
  organizedStatus: procedure
    .route({ method: "POST", path: "/invitations/organized/status" })
    .input(z.object({ accountId: IdSchema, eventId: IdSchema }))
    .output(
      z.object({
        organizer: z.email(),
        sequence: z.number().int().nonnegative(),
        cancelled: z.boolean(),
        pendingOperationId: z.uuid().nullable(),
        attendees: z.array(
          z.object({
            email: z.email(),
            partstat: z.string(),
            occurrence: z.string(),
          }),
        ),
      }),
    ),
  unverifiedReplies: procedure
    .route({ method: "POST", path: "/invitations/organized/unverified" })
    .input(z.object({ accountId: IdSchema, cursor: IdSchema.optional() }))
    .output(
      z.object({
        messageIds: z.array(IdSchema),
        nextCursor: IdSchema.nullable(),
      }),
    ),
  processReply: procedure
    .route({ method: "POST", path: "/invitations/organized/reply" })
    .input(z.object({ accountId: IdSchema, messageId: IdSchema }))
    .output(
      z.object({
        senderStatus: z.enum(["verified", "unverified"]),
        verificationPending: z.boolean(),
        event: InvitationEventSchema,
        from: z.array(z.email()),
        occurrence: z.string(),
        result: z.enum([
          "applied",
          "pending",
          "unverified",
          "stale",
          "duplicate",
          "conflict",
        ]),
      }),
    ),
  reconcileOrganized: procedure
    .route({ method: "POST", path: "/invitations/organized/reconcile" })
    .input(z.object({ accountId: IdSchema, operationId: z.uuid() }))
    .output(InvitationResultSchema),
  read: procedure
    .route({ method: "POST", path: "/invitations/read" })
    .input(z.object({ accountId: IdSchema, messageId: IdSchema }))
    .output(InvitationSchema),
  act: procedure
    .route({ method: "POST", path: "/invitations/act" })
    .input(InvitationActionSchema)
    .output(InvitationResultSchema),
  confirm: procedure
    .route({ method: "POST", path: "/invitations/confirm" })
    .input(InvitationActionSchema)
    .output(InvitationResultSchema),
  reconcile: procedure
    .route({ method: "POST", path: "/invitations/reconcile" })
    .input(z.object({ accountId: IdSchema, operationId: z.uuid() }))
    .output(InvitationResultSchema),
};
