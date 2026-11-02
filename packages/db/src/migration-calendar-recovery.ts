import type { PrismaClient } from "./generated/index.js";

export type ImportPreview = {
  id: string;
  previewState: "new" | "update" | "duplicate" | "conflict" | "invalid";
  previewReason: string | null;
};

/** Fence stale workers when an absent target is replaced or abandoned. */
export function recoverCalendarImport(
  db: PrismaClient,
  userId: string,
  jobId: string,
  generation: number,
  oldCalendarId: string,
  input:
    | { action: "retarget"; calendarId: string; preview: ImportPreview[] }
    | { action: "abandon" },
) {
  return db.$transaction(async (tx) => {
    const updated = await tx.calendarImportJob.updateMany({
      where: {
        id: jobId,
        userId,
        generation,
        calendarId: oldCalendarId,
        abandoned: false,
      },
      data: {
        generation: { increment: 1 },
        confirmed: false,
        abandoned: input.action === "abandon",
        ...(input.action === "retarget"
          ? { calendarId: input.calendarId }
          : {}),
      },
    });
    if (updated.count !== 1) return false;
    await tx.calendarImportItem.updateMany({
      where: { jobId },
      data: { generation: { increment: 1 } },
    });
    if (input.action === "abandon") {
      await tx.calendarImportItem.updateMany({
        where: { jobId, state: "pending" },
        data: { state: "abandoned", error: "Import abandoned" },
      });
      await tx.calendarImportItem.updateMany({
        where: { jobId, state: "processing" },
        data: {
          state: "abandoned",
          error:
            "Import abandoned; an in-flight event may have completed or may still complete",
        },
      });
    } else {
      await tx.calendarImportItem.updateMany({
        where: { jobId, event: { not: null } },
        data: { state: "pending", error: null, eventId: null },
      });
      await Promise.all(
        input.preview.map((item) =>
          tx.calendarImportItem.updateMany({
            where: { id: item.id, jobId },
            data: {
              previewState: item.previewState,
              previewReason: item.previewReason,
            },
          }),
        ),
      );
    }
    return true;
  });
}
