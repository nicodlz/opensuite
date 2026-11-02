import { z } from "zod";
import type { Prisma } from "./generated/index.js";

type Job = Prisma.CalendarImportJobGetPayload<{ include: { items: true } }>;
const issues = z.array(z.string());
/** Remove stored source and prepared event data from the public job view. */
export function projectCalendarImport(job: Job) {
  return {
    id: job.id,
    accountId: job.accountId,
    calendarId: job.calendarId,
    confirmed: job.confirmed,
    abandoned: job.abandoned,
    previewCounts: {
      new: job.items.filter((item) => item.previewState === "new").length,
      update: job.items.filter((item) => item.previewState === "update").length,
      duplicate: job.items.filter((item) => item.previewState === "duplicate")
        .length,
      conflict: job.items.filter((item) => item.previewState === "conflict")
        .length,
      invalid: job.items.filter((item) => item.previewState === "invalid")
        .length,
    },
    progress: {
      total: job.items.length,
      completed: job.items.filter((item) =>
        ["imported", "duplicate", "failed", "abandoned"].includes(item.state),
      ).length,
      imported: job.items.filter((item) => item.state === "imported").length,
      duplicate: job.items.filter((item) => item.state === "duplicate").length,
      failed: job.items.filter((item) => item.state === "failed").length,
      abandoned: job.items.filter((item) => item.state === "abandoned").length,
    },
    items: job.items.map((item) => ({
      index: item.index,
      file: item.file,
      uid: item.uid,
      title: item.title,
      state: item.state,
      preview: item.previewState,
      previewReason: item.previewReason,
      issues: issues.parse(JSON.parse(item.issues)),
      error: item.error,
    })),
  };
}
