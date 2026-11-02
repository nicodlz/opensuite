import { z } from "zod";
import { err, ok, ResultAsync } from "neverthrow";
import type { JmapClient, Session, JmapResult } from "@opensuite/jmap";
import type { CalendarImportStore } from "@opensuite/db";
import { previewCalendarEvent } from "../domain/migration-calendar.ts";

type PreviewInput = {
  uid: string | null;
  sourceId: string;
  event: string | null;
  previewReason: string | null;
};
type PreviewOutcome = ReturnType<typeof previewCalendarEvent>;
export async function previews(
  c: { client: JmapClient; session: Session; id: string },
  store: CalendarImportStore,
  userId: string,
  accountId: string,
  calendarId: string,
  rows: readonly PreviewInput[],
): Promise<JmapResult<PreviewOutcome[]>> {
  const uids = [
    ...new Set(rows.flatMap((row) => (row.uid && row.event ? [row.uid] : []))),
  ];
  if (!uids.length)
    return ok(
      rows.map((row) => ({
        previewState: "invalid" as const,
        previewReason: row.previewReason ?? "Event could not be parsed",
      })),
    );
  const scanned = await c.client.scanCalendarUids(c.session, c.id, uids);
  if (scanned.isErr()) return err(scanned.error);
  const identities = await ResultAsync.fromPromise(
    store.identities(userId, accountId, calendarId, uids),
    () => ({
      kind: "invalidResponse" as const,
      message: "Calendar import state unavailable",
    }),
  );
  if (identities.isErr()) return err(identities.error);
  const seen = new Set<string>();
  try {
    return ok(
      rows.map((row) => {
        if (!row.uid || !row.event)
          return {
            previewState: "invalid" as const,
            previewReason: row.previewReason ?? "Event could not be parsed",
          };
        if (seen.has(row.uid))
          return {
            previewState: "conflict" as const,
            previewReason: "UID appears in multiple selected files",
          };
        seen.add(row.uid);
        const desired = z
          .record(z.string(), z.unknown())
          .parse(JSON.parse(row.event));
        return previewCalendarEvent(
          desired,
          scanned.value.found.filter((event) => event.uid === row.uid),
          identities.value.find((identity) => identity.uid === row.uid),
          calendarId,
          row.sourceId,
        );
      }),
    );
  } catch {
    return err({
      kind: "invalidResponse",
      message: "Invalid saved calendar event",
    });
  }
}
