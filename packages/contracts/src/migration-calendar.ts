import { oc } from "@orpc/contract";
import { z } from "zod";
import { IdSchema } from "./mail.ts";

export const calendarImportLimits = {
  files: 10,
  bytes: 750_000,
  events: 200,
  expandedBytes: 2_000_000,
  jobs: 10,
} as const;

export const CalendarImportFileSchema = z.object({
  name: z.string().min(1).max(255),
  sourceId: z.string().min(1).max(255).optional(),
  content: z.string().min(1).max(calendarImportLimits.bytes),
});
export const CalendarImportItemSchema = z.object({
  index: z.number().int().nonnegative(),
  file: z.string(),
  sourceId: z.string(),
  uid: z.string().nullable(),
  title: z.string(),
  state: z.enum([
    "pending",
    "processing",
    "imported",
    "duplicate",
    "failed",
    "abandoned",
  ]),
  preview: z.enum(["new", "update", "duplicate", "conflict", "invalid"]),
  previewReason: z.string().nullable(),
  issues: z.array(z.string()),
  error: z.string().nullable(),
});
export const CalendarImportJobSchema = z.object({
  id: IdSchema,
  accountId: IdSchema,
  calendarId: IdSchema,
  confirmed: z.boolean(),
  abandoned: z.boolean(),
  previewCounts: z.object({
    new: z.number().int().nonnegative(),
    update: z.number().int().nonnegative(),
    duplicate: z.number().int().nonnegative(),
    conflict: z.number().int().nonnegative(),
    invalid: z.number().int().nonnegative(),
  }),
  progress: z.object({
    total: z.number().int().nonnegative(),
    completed: z.number().int().nonnegative(),
    imported: z.number().int().nonnegative(),
    duplicate: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    abandoned: z.number().int().nonnegative(),
  }),
  items: z.array(CalendarImportItemSchema),
});
const procedure = oc.errors({
  NOT_FOUND: { status: 404, message: "Import not found" },
  TARGET_NOT_FOUND: {
    status: 404,
    message: "Target calendar not found; choose another or abandon the import",
  },
  FORBIDDEN: { status: 403, message: "Access denied" },
  VALIDATION: {
    status: 400,
    message: `Invalid calendar import or limits exceeded: ${String(calendarImportLimits.files)} files, ${String(calendarImportLimits.bytes)} bytes, ${String(calendarImportLimits.events)} events, and ${String(calendarImportLimits.expandedBytes)} expanded bytes`,
  },
  CONFLICT: { status: 409, message: "Calendar import changed" },
  TOO_MANY_REQUESTS: { status: 429, message: "Too many calendar imports" },
  UPSTREAM_UNAVAILABLE: {
    status: 503,
    message: "Calendar service unavailable",
  },
});
const job = z.object({ jobId: IdSchema });
export const migrationCalendarContract = {
  preview: procedure
    .route({ method: "POST", path: "/migration/calendar/preview" })
    .input(
      z.object({
        accountId: IdSchema,
        calendarId: IdSchema,
        files: z
          .array(CalendarImportFileSchema)
          .min(1)
          .max(calendarImportLimits.files),
      }),
    )
    .output(CalendarImportJobSchema),
  list: procedure
    .route({ method: "POST", path: "/migration/calendar/list" })
    .input(z.object({ accountId: IdSchema }))
    .output(z.object({ jobs: z.array(CalendarImportJobSchema) })),
  get: procedure
    .route({ method: "POST", path: "/migration/calendar/get" })
    .input(job)
    .output(CalendarImportJobSchema),
  delete: procedure
    .route({ method: "POST", path: "/migration/calendar/delete" })
    .input(job)
    .output(z.object({ success: z.literal(true) })),
  confirm: procedure
    .route({ method: "POST", path: "/migration/calendar/confirm" })
    .input(job)
    .output(CalendarImportJobSchema),
  recover: procedure
    .route({ method: "POST", path: "/migration/calendar/recover" })
    .input(
      z.discriminatedUnion("action", [
        job.extend({ action: z.literal("retarget"), calendarId: IdSchema }),
        job.extend({ action: z.literal("abandon") }),
      ]),
    )
    .output(CalendarImportJobSchema),
  resume: procedure
    .route({ method: "POST", path: "/migration/calendar/resume" })
    .input(job)
    .output(CalendarImportJobSchema),
};
export type CalendarImportFile = z.infer<typeof CalendarImportFileSchema>;
export type CalendarImportItem = z.infer<typeof CalendarImportItemSchema>;
export type CalendarImportJob = z.infer<typeof CalendarImportJobSchema>;
