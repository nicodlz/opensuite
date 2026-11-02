import { oc } from "@orpc/contract";
import { z } from "zod";
import { IdSchema } from "./mail.ts";

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
export const invitationsContract = {
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
