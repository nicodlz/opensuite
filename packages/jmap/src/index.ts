import { err, ok } from "neverthrow";
import { z } from "zod";
import { readPortableBody, type Session } from "./protocol.ts";
import { MigrationMailClient } from "./migration-mail.ts";
import { fenceDraftMutation } from "./draft-mutation.ts";
import { mailMapping } from "./mail-content.ts";
import { ScheduledSubmissions } from "./scheduled-send.ts";
import { threadPage } from "./thread-page.ts";
import { validatePageResponses } from "./page-response.ts";

export { inspectMigrationCandidates } from "./migration-candidates.ts";
export { migrationUploadFailure } from "./migration-failures.ts";
export {
  resolveMigrationCandidate,
  migrationMailboxPatch,
} from "./migration-resolve.ts";
export { refreshMigrationSnapshot } from "./migration-changes.ts";
export { runMigrationItem } from "./migration-retry.ts";
export {
  captureMigrationDestinations,
  checkMigrationDestinations,
} from "./migration-destinations.ts";
export {
  createMigrationSnapshot,
  rememberMigrationImport,
} from "./migration-snapshot.ts";
export type {
  MigrationCandidate,
  MigrationSnapshot,
} from "./migration-snapshot.ts";
export { JmapCapability } from "./protocol.ts";
export { delayedSendTiming, matchesSubmission } from "./scheduled-send.ts";
export type {
  JmapError,
  JmapResult,
  Session,
  TransportOptions,
} from "./protocol.ts";
export type {
  Mailbox,
  Email,
  Identity,
  Calendar,
  CalendarEvent,
  RecurrenceRule,
} from "./schemas.ts";

const portableEnvelope = z.object({
  methodResponses: z.array(z.tuple([z.string(), z.unknown(), z.string()])),
});
function portableCalls(bytes: Uint8Array, expected: string[][]) {
  try {
    const envelope = portableEnvelope.safeParse(
      JSON.parse(new TextDecoder().decode(bytes)),
    );
    if (!envelope.success)
      return err({
        kind: "invalidResponse" as const,
        message: "Invalid JMAP response",
      });
    return validatePageResponses(envelope.data.methodResponses, expected);
  } catch {
    return err({
      kind: "invalidResponse" as const,
      message: "Invalid JMAP response",
    });
  }
}

const calendarPageSchema = z.object({
  methodResponses: z.tuple([
    z.tuple([
      z.literal("CalendarEvent/query"),
      z.object({
        accountId: z.string(),
        ids: z.array(z.string()).max(50),
        queryState: z.string(),
      }),
      z.literal("query"),
    ]),
    z.tuple([
      z.literal("CalendarEvent/get"),
      z.object({
        accountId: z.string(),
        state: z.string(),
        list: z
          .array(
            z.looseObject({
              id: z.string(),
              uid: z.string().optional(),
            }),
          )
          .max(50),
        notFound: z.array(z.string()),
      }),
      z.literal("events"),
    ]),
  ]),
});

/** The authorization value is supplied by the caller; keep user credentials server-side. */
export class JmapClient extends MigrationMailClient {
  readonly mailMapping = mailMapping;
  readonly scheduled = new ScheduledSubmissions(this.transport);
  fenceDraftMutation(input: Parameters<typeof fenceDraftMutation>[1]) {
    return fenceDraftMutation(this, input);
  }
  /** Read a blob with a hard byte limit, including when Content-Length is absent. */
  async portableBlob(
    session: Session,
    accountId: string,
    blobId: string,
    limit: number,
  ) {
    const values: Record<string, string> = {
      accountId,
      blobId,
      name: "message.eml",
      type: "message/rfc822",
    };
    const url = session.downloadUrl.replace(
      /\{([^}]+)\}/g,
      (_match, key: string) => encodeURIComponent(values[key] ?? ""),
    );
    const response = await this.transport.request(url);
    if (response.isErr()) return err(response.error);
    return readPortableBody(response.value, limit);
  }

  async portableMetadata(
    session: Session,
    accountId: string,
    ids: readonly string[],
  ) {
    const response = await this.transport.request(session.apiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"],
        methodCalls: [
          [
            "Email/get",
            { accountId, ids, properties: ["id", "blobId", "size"] },
            "0",
          ],
        ],
      }),
    });
    if (response.isErr()) return err(response.error);
    const body = await readPortableBody(response.value, 256_000);
    if (body.isErr()) return err(body.error);
    const calls = portableCalls(body.value, [["Email/get", "0"]]);
    if (calls.isErr()) return err(calls.error);
    try {
      const parsed = z
        .object({
          methodResponses: z.tuple([
            z.tuple([
              z.literal("Email/get"),
              z.object({
                accountId: z.string(),
                list: z.array(
                  z.object({
                    id: z.string(),
                    blobId: z.string(),
                    size: z.number().int().nonnegative(),
                  }),
                ),
                notFound: z.array(z.string()),
              }),
              z.literal("0"),
            ]),
          ]),
        })
        .safeParse({ methodResponses: calls.value });
      if (
        !parsed.success ||
        parsed.data.methodResponses[0][1].accountId !== accountId
      )
        return err({
          kind: "invalidResponse" as const,
          message: "Invalid email metadata",
        });
      return ok(parsed.data.methodResponses[0][1]);
    } catch {
      return err({
        kind: "invalidResponse" as const,
        message: "Invalid email metadata",
      });
    }
  }

  async portableCalendarPage(
    session: Session,
    accountId: string,
    position: number,
  ) {
    const response = await this.transport.request(session.apiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:calendars"],
        methodCalls: [
          ["CalendarEvent/query", { accountId, position, limit: 50 }, "query"],
          [
            "CalendarEvent/get",
            {
              accountId,
              "#ids": {
                resultOf: "query",
                name: "CalendarEvent/query",
                path: "/ids",
              },
            },
            "events",
          ],
        ],
      }),
    });
    if (response.isErr()) return err(response.error);
    const body = await readPortableBody(response.value, 4_000_000);
    if (body.isErr()) return err(body.error);
    const calls = portableCalls(body.value, [
      ["CalendarEvent/query", "query"],
      ["CalendarEvent/get", "events"],
    ]);
    if (calls.isErr()) return err(calls.error);
    try {
      const parsed = calendarPageSchema.safeParse({
        methodResponses: calls.value,
      });
      if (!parsed.success)
        return err({
          kind: "invalidResponse" as const,
          message: "Invalid calendar page",
        });
      const query = parsed.data.methodResponses[0][1];
      const events = parsed.data.methodResponses[1][1];
      if (
        query.accountId !== accountId ||
        events.accountId !== accountId ||
        events.notFound.length ||
        events.list.length !== query.ids.length ||
        events.list.some((event) => !query.ids.includes(event.id))
      )
        return err({
          kind: "invalidResponse" as const,
          message: "Incomplete calendar page",
        });
      return ok({ query, events });
    } catch {
      return err({
        kind: "invalidResponse" as const,
        message: "Invalid calendar page",
      });
    }
  }

  threadPage(
    ...args: Parameters<typeof threadPage> extends [unknown, ...infer Rest]
      ? Rest
      : never
  ) {
    return threadPage(this.transport, ...args);
  }
}
