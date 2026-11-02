import { z } from "zod";
import type { Session } from "./protocol.ts";
import { ClientBase } from "./client-base.ts";
import {
  MailboxSchema,
  EmailSchema,
  GetSchema,
  QuerySchema,
  emailProperties,
  usingMail,
} from "./schemas.ts";

export class MailReadClient extends ClientBase {
  mailboxes(session: Session, accountId: string) {
    return this.transport.call(
      session.apiUrl,
      "Mailbox/get",
      {
        accountId,
        properties: [
          "id",
          "name",
          "role",
          "parentId",
          "totalEmails",
          "unreadEmails",
        ],
      },
      usingMail,
      GetSchema(MailboxSchema),
    );
  }
  emailState(session: Session, accountId: string) {
    return this.transport.call(
      session.apiUrl,
      "Email/get",
      { accountId, ids: [], properties: ["id"] },
      usingMail,
      GetSchema(z.object({ id: z.string() })),
    );
  }
  emailChanges(session: Session, accountId: string, sinceState: string) {
    return this.transport.call(
      session.apiUrl,
      "Email/changes",
      { accountId, sinceState, maxChanges: 500 },
      usingMail,
      z.object({
        accountId: z.string(),
        oldState: z.string(),
        newState: z.string(),
        hasMoreChanges: z.boolean(),
        created: z.array(z.string()),
        updated: z.array(z.string()),
        destroyed: z.array(z.string()),
      }),
    );
  }
  notificationEmails(
    session: Session,
    accountId: string,
    ids: readonly string[],
  ) {
    return this.transport.call(
      session.apiUrl,
      "Email/get",
      {
        accountId,
        ids,
        properties: [
          "id",
          "threadId",
          "mailboxIds",
          "keywords",
          "receivedAt",
          "subject",
          "from",
        ],
      },
      usingMail,
      GetSchema(
        EmailSchema.pick({
          id: true,
          threadId: true,
          mailboxIds: true,
          keywords: true,
          receivedAt: true,
          subject: true,
          from: true,
        }),
      ),
    );
  }
  queryEmails(
    session: Session,
    accountId: string,
    options: {
      filter?: object;
      sort?: readonly object[];
      position?: number;
      anchor?: string;
      anchorOffset?: number;
      limit?: number;
      collapseThreads?: boolean;
      calculateTotal?: boolean;
    } = {},
  ) {
    return this.transport.call(
      session.apiUrl,
      "Email/query",
      { accountId, ...options },
      usingMail,
      QuerySchema,
    );
  }
  emails(session: Session, accountId: string, ids: readonly string[]) {
    return this.transport.call(
      session.apiUrl,
      "Email/get",
      {
        accountId,
        ids,
        properties: emailProperties,
        fetchAllBodyValues: true,
      },
      usingMail,
      GetSchema(EmailSchema),
    );
  }
  threads(session: Session, accountId: string, ids: readonly string[]) {
    return this.transport.call(
      session.apiUrl,
      "Thread/get",
      { accountId, ids },
      usingMail,
      GetSchema(z.object({ id: z.string(), emailIds: z.array(z.string()) })),
    );
  }
}
