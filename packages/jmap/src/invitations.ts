import { z } from "zod";
import { CalendarClient } from "./calendar-client.ts";
import { JmapCapability, type Session } from "./protocol.ts";
import { GetSchema, QuerySchema } from "./schemas.ts";
import { submissionCapabilities, SubmissionCore } from "./submission-schema.ts";

/** JMAP operations needed to apply and respond to received invitations. */
export class InvitationClient extends CalendarClient {
  parseCalendar(session: Session, accountId: string, blobId: string) {
    return this.transport.call(
      session.apiUrl,
      "CalendarEvent/parse",
      { accountId, blobIds: [blobId] },
      [
        JmapCapability.core,
        JmapCapability.calendars,
        "urn:ietf:params:jmap:calendars:parse",
      ],
      z.object({
        accountId: z.string(),
        parsed: z
          .record(z.string(), z.array(z.record(z.string(), z.unknown())))
          .nullable()
          .optional(),
        notFound: z.array(z.string()).nullable().optional(),
        notParsable: z.array(z.string()).nullable().optional(),
      }),
    );
  }
  submissionQuery(session: Session, accountId: string, emailId: string) {
    return this.transport.call(
      session.apiUrl,
      "EmailSubmission/query",
      { accountId, filter: { emailIds: [emailId] }, limit: 2 },
      submissionCapabilities,
      QuerySchema,
    );
  }
  submissions(session: Session, accountId: string, ids: readonly string[]) {
    return this.transport.call(
      session.apiUrl,
      "EmailSubmission/get",
      {
        accountId,
        ids,
        properties: ["id", "emailId", "identityId", "envelope", "undoStatus"],
      },
      submissionCapabilities,
      GetSchema(
        SubmissionCore.extend({
          envelope: z
            .object({
              mailFrom: z.object({ email: z.string() }),
              rcptTo: z.array(z.object({ email: z.string() })),
            })
            .nullable(),
        }),
      ),
    );
  }
}
