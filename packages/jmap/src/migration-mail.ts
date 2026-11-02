import { z } from "zod";
import { CalendarClient } from "./calendar-client.ts";
import type { Session } from "./protocol.ts";
import { GetSchema, usingMail } from "./schemas.ts";

const MigrationEmailSchema = z.object({
  id: z.string(),
  blobId: z.string(),
  size: z.number().int().nonnegative(),
  messageId: z.array(z.string()).nullable(),
  keywords: z.record(z.string(), z.boolean()),
});

export class MigrationMailClient extends CalendarClient {
  migrationEmails(session: Session, accountId: string, ids: readonly string[]) {
    return this.transport.call(
      session.apiUrl,
      "Email/get",
      {
        accountId,
        ids,
        properties: ["id", "blobId", "size", "messageId", "keywords"],
      },
      usingMail,
      GetSchema(MigrationEmailSchema),
    );
  }
}
