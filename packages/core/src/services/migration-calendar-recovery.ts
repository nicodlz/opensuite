import {
  CalendarImportJobSchema,
  type CalendarImportJob,
  type CalendarImportFile,
} from "@opensuite/contracts";
import type {
  CalendarImportStore,
  CalendarImportRow as Row,
} from "@opensuite/db";
import { err, ok, type Result } from "neverthrow";
import { z } from "zod";
import type { ImportPreviewState } from "../domain/migration-calendar.ts";
import { calendarWriteAccess } from "../domain/calendar-edit.ts";
import type { Actor } from "./accounts.ts";
import {
  fail,
  value,
  type createJmapAccess,
  type AccessFailureKind,
} from "./jmap-access.ts";

export type ImportConnection = Awaited<
  ReturnType<ReturnType<typeof createJmapAccess>["connect"]>
>;
type JmapFailure =
  Awaited<
    ReturnType<ImportConnection["client"]["scanCalendarUids"]>
  > extends Result<unknown, infer E>
    ? E
    : never;
type PreviewInput = Pick<Row, "uid" | "sourceId" | "event" | "previewReason">;
type PreviewResult = Result<
  { previewState: ImportPreviewState; previewReason: string | null }[],
  JmapFailure
>;
export type ImportDependencies = Parameters<typeof createJmapAccess>[0] & {
  imports: CalendarImportStore;
  parser: {
    splitCalendars(
      files: CalendarImportFile[],
    ): Result<Row[], { kind: "validation"; message: string }>;
    applyParsed(
      row: Row,
      parsed: Record<string, unknown>[] | undefined,
    ): Result<void, { kind: "unavailable" }>;
  };
  previews(
    c: ImportConnection,
    store: CalendarImportStore,
    userId: string,
    accountId: string,
    calendarId: string,
    rows: readonly PreviewInput[],
  ): Promise<PreviewResult>;
};
export type ImportJob = NonNullable<
  Awaited<ReturnType<CalendarImportStore["get"]>>
>;

const issues = z.array(z.string());
/** Remove stored source and prepared event data from the public job view. */
function projectCalendarImport(job: ImportJob) {
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
      sourceId: item.sourceId,
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

export const publicJob = (job: ImportJob): CalendarImportJob =>
  CalendarImportJobSchema.parse(projectCalendarImport(job));

export async function assertImportWritable(
  c: ImportConnection,
  calendarId: string,
) {
  const calendars = value(await c.client.calendars(c.session, c.id)).list;
  const access = calendarWriteAccess(calendars, calendarId);
  if (access === "forbidden") fail("forbidden");
  return access === "allowed";
}
export function targetResult<T>(
  result: Result<T | null, { kind: AccessFailureKind }>,
) {
  if (result.isErr()) return err(result.error);
  return result.value === null
    ? err({ kind: "target_missing" as const })
    : ok(result.value);
}
export async function confirmCalendarImport(
  deps: ImportDependencies,
  c: ImportConnection,
  actor: Actor,
  job: ImportJob,
) {
  if (job.abandoned) return fail("conflict");
  if (!(await assertImportWritable(c, job.calendarId))) return null;
  if (
    !job.confirmed &&
    (await deps.imports.confirm(actor.id, job.id, job.generation)).count !== 1
  )
    return fail("conflict");
  return publicJob(
    (await deps.imports.get(actor.id, job.id)) ?? fail("not_found"),
  );
}
export async function recoverCalendarImport(
  deps: ImportDependencies,
  c: ImportConnection,
  actor: Actor,
  job: ImportJob,
  input: { action: "retarget"; calendarId: string } | { action: "abandon" },
) {
  if (job.abandoned) return fail("conflict");
  if (input.action === "retarget") {
    const calendars = value(await c.client.calendars(c.session, c.id)).list;
    if (calendars.some((calendar) => calendar.id === job.calendarId))
      return fail("conflict");
    const access = calendarWriteAccess(calendars, input.calendarId);
    if (access === "not_found") return null;
    if (access === "forbidden") return fail("forbidden");
    const previews = value(
      await deps.previews(
        c,
        deps.imports,
        actor.id,
        job.accountId,
        input.calendarId,
        job.items,
      ),
    );
    const preview = job.items.map((item, index) => ({
      id: item.id,
      ...(previews[index] ?? {
        previewState: "invalid" as const,
        previewReason: "Event could not be parsed",
      }),
    }));
    if (
      !(await deps.imports.recover(
        actor.id,
        job.id,
        job.generation,
        job.calendarId,
        { action: "retarget", calendarId: input.calendarId, preview },
      ))
    )
      return fail("conflict");
  } else if (
    !(await deps.imports.recover(
      actor.id,
      job.id,
      job.generation,
      job.calendarId,
      input,
    ))
  )
    return fail("conflict");
  return publicJob(
    (await deps.imports.get(actor.id, job.id)) ?? fail("not_found"),
  );
}
