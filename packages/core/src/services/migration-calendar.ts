/* Sequential requests bound work and preserve a consistent JMAP state. */
/* oxlint-disable eslint/no-await-in-loop */

import type { CalendarImportFile } from "@opensuite/contracts";
import type { CalendarImportRow as Row } from "@opensuite/db";
import { z } from "zod";
import {
  publicJob,
  assertImportWritable,
  confirmCalendarImport,
  recoverCalendarImport,
  targetResult,
  type ImportDependencies,
  type ImportConnection,
  type ImportJob,
} from "./migration-calendar-recovery.ts";
import {
  planCalendarEvent,
  type ImportEvent,
} from "../domain/migration-calendar.ts";
import type { Actor } from "./accounts.ts";
import { createJmapAccess, fail, value } from "./jmap-access.ts";

const eventSchema = z.record(z.string(), z.unknown());

type Item = ImportJob["items"][number];
type Scan = { state: string; found: ImportEvent[] };
type Work = {
  actor: Actor;
  job: ImportJob;
  item: Item;
  connection: ImportConnection;
  desired: Record<string, unknown>;
  scan: Scan;
  wasPending: boolean;
  identity: Pick<ImportJob, "accountId" | "calendarId"> & {
    uid: string;
    source: string;
  };
};

class CalendarImporter {
  private readonly access;
  private readonly deps: ImportDependencies;
  constructor(dependencies: ImportDependencies) {
    this.deps = dependencies;
    this.access = createJmapAccess(dependencies);
  }
  private connect(actor: Actor, accountId: string) {
    return this.access.connect(
      actor,
      accountId,
      "urn:ietf:params:jmap:calendars",
    );
  }
  private async resolve(actor: Actor, accountId: string) {
    const credential = await this.deps.store.getForOwner(actor.id, accountId);
    if (credential.isErr())
      return fail(
        credential.error.kind === "forbidden" ||
          credential.error.kind === "not_found"
          ? "forbidden"
          : "unavailable",
      );
    if (accountId !== "default" && accountId !== credential.value.accountId)
      return fail("forbidden");
    return credential.value.accountId;
  }
  private async job(actor: Actor, id: string) {
    return (await this.deps.imports.get(actor.id, id)) ?? fail("not_found");
  }
  private async scan(c: ImportConnection, uid: string): Promise<Scan> {
    return value(await c.client.scanCalendarUid(c.session, c.id, uid));
  }
  private async parseRow(c: ImportConnection, row: Row) {
    if (row.state === "failed") return;
    const blob = value(
      await c.client.upload(
        c.session,
        c.id,
        Buffer.from(row.source),
        "text/calendar",
      ),
    );
    const result = value(
      await c.client.parseCalendar(c.session, c.id, blob.blobId),
    );
    const applied = this.deps.parser.applyParsed(
      row,
      result.parsed?.[blob.blobId],
    );
    if (applied.isErr()) fail(applied.error.kind);
  }
  preview(
    actor: Actor,
    input: {
      accountId: string;
      calendarId: string;
      files: CalendarImportFile[];
    },
  ) {
    return this.access
      .run(async () => {
        if (!(await this.deps.imports.hasCapacity(actor.id)))
          return fail("rate_limited");
        const parsed = this.deps.parser.splitCalendars(input.files);
        if (parsed.isErr()) return fail(parsed.error.kind);
        const rows = parsed.value;
        const accountId = await this.resolve(actor, input.accountId);
        const c = await this.connect(actor, accountId);
        if (!(await assertImportWritable(c, input.calendarId))) return null;
        for (const row of rows) await this.parseRow(c, row);
        const previews = value(
          await this.deps.previews(
            c,
            this.deps.imports,
            actor.id,
            accountId,
            input.calendarId,
            rows,
          ),
        );
        rows.forEach((row, index) => Object.assign(row, previews[index] ?? {}));
        const saved = await this.deps.imports.create(
          actor.id,
          accountId,
          input.calendarId,
          rows,
        );
        if (!saved) return fail("rate_limited");
        return publicJob(saved);
      })
      .then(targetResult);
  }
  list(actor: Actor, accountId: string) {
    return this.access.run(async () => {
      const jobs = await this.deps.imports.list(
        actor.id,
        accountId === "default" ? undefined : accountId,
      );
      return {
        jobs: jobs.map((job) => publicJob(job)),
      };
    });
  }
  get(actor: Actor, id: string) {
    return this.access.run(async () => {
      return publicJob(await this.job(actor, id));
    });
  }
  private finish(
    w: Work,
    state: "imported" | "duplicate" | "failed",
    error: string | null,
    eventId: string | null,
    remember = false,
  ) {
    return this.deps.imports.finish({
      userId: w.actor.id,
      jobId: w.job.id,
      itemId: w.item.id,
      state,
      error,
      eventId,
      identity: remember ? w.identity : undefined,
      generation: w.job.generation,
    });
  }
  private conflict(w: Work, message: string) {
    return this.finish(w, "failed", message, null);
  }
  private async merge(
    w: Work,
    match: ImportEvent,
    additions: Record<string, unknown>,
  ) {
    const c = w.connection;
    const updated = await c.client.importCalendarOverrides(
      c.session,
      c.id,
      match.id,
      additions,
      w.scan.state,
      Boolean(match.recurrenceOverrides),
    );
    if (updated.isOk()) return this.finish(w, "imported", null, match.id);
    if (
      (updated.error.kind === "set" || updated.error.kind === "method") &&
      updated.error.type !== "stateMismatch"
    )
      return this.conflict(
        w,
        `Calendar server rejected the occurrence: ${updated.error.type}`,
      );
    return undefined;
  }
  private async existing(w: Work) {
    const prior = await this.deps.imports.identity(
      w.actor.id,
      w.job.accountId,
      w.job.calendarId,
      w.identity.uid,
    );
    const plan = planCalendarEvent(
      w.desired,
      w.scan.found,
      prior ?? undefined,
      w.job.calendarId,
      w.item.sourceId,
    );
    if (plan.previewState === "conflict")
      return this.conflict(w, plan.previewReason);
    const match = w.scan.found[0] ?? fail("unavailable");
    if (plan.previewState === "duplicate")
      return this.finish(
        w,
        w.wasPending ? "duplicate" : "imported",
        null,
        match.id,
        !prior?.eventId,
      );
    if (plan.previewState === "update")
      return this.merge(w, match, plan.additions);
    return fail("unavailable");
  }

  private async create(w: Work) {
    const reserved = await this.deps.imports.reserve(
      w.actor.id,
      w.job.accountId,
      w.job.calendarId,
      w.identity.uid,
      w.item.sourceId,
    );
    if (!reserved || reserved.source !== w.item.sourceId)
      return this.conflict(
        w,
        "UID was previously imported or reserved by another source",
      );
    const c = w.connection;
    const created = await c.client.importCalendarEvent(
      c.session,
      c.id,
      { ...w.desired, calendarIds: { [w.job.calendarId]: true } },
      w.scan.state,
    );
    if (created.isOk())
      return this.finish(w, "imported", null, created.value.id, true);
    if (
      (created.error.kind === "set" || created.error.kind === "method") &&
      created.error.type !== "stateMismatch"
    )
      return this.finish(
        w,
        "failed",
        `Calendar server rejected the event: ${created.error.type}`,
        null,
        true,
      );
    return undefined;
  }
  private async process(
    actor: Actor,
    stored: ImportJob,
    c: ImportConnection,
    item: Item,
  ) {
    const wasPending = item.state === "pending";
    const uid = item.uid ?? fail("unavailable");
    const event = item.event ?? fail("unavailable");
    const desired = eventSchema.parse(JSON.parse(event));
    const scan = await this.scan(c, uid);
    if (
      (
        await this.deps.imports.processing(
          actor.id,
          stored.id,
          item.id,
          stored.generation,
          wasPending,
        )
      ).count !== 1
    )
      return;
    const identity = {
      accountId: stored.accountId,
      calendarId: stored.calendarId,
      uid,
      source: item.sourceId,
    };
    const w = {
      actor,
      job: stored,
      item,
      connection: c,
      desired,
      scan,
      wasPending,
      identity,
    };
    if (scan.found.length) await this.existing(w);
    else await this.create(w);
  }
  confirm(actor: Actor, id: string) {
    return this.access
      .run(async () => {
        const stored = await this.job(actor, id);
        const c = await this.connect(actor, stored.accountId);
        return confirmCalendarImport(this.deps, c, actor, stored);
      })
      .then(targetResult);
  }
  recover(
    actor: Actor,
    id: string,
    input: { action: "retarget"; calendarId: string } | { action: "abandon" },
  ) {
    return this.access
      .run(async () => {
        const stored = await this.job(actor, id);
        const c = await this.connect(actor, stored.accountId);
        return recoverCalendarImport(this.deps, c, actor, stored, input);
      })
      .then(targetResult);
  }
  resume(actor: Actor, id: string) {
    return this.access
      .run(async () => {
        const stored = await this.job(actor, id);
        const c = await this.connect(actor, stored.accountId);
        if (!(await assertImportWritable(c, stored.calendarId))) return null;
        if (!stored.confirmed || stored.abandoned) return fail("conflict");
        const item = stored.items.find(
          (entry) => entry.state === "processing" || entry.state === "pending",
        );
        if (item) await this.process(actor, stored, c, item);
        return publicJob(await this.job(actor, id));
      })
      .then(targetResult);
  }
  delete(actor: Actor, id: string) {
    return this.access.run(async () => {
      if ((await this.deps.imports.delete(actor.id, id)).count !== 1)
        return fail("conflict");
      return { success: true as const };
    });
  }
}
export function createCalendarImportService(dependencies: ImportDependencies) {
  return new CalendarImporter(dependencies);
}
export type CalendarImportService = Pick<
  CalendarImporter,
  "preview" | "list" | "get" | "confirm" | "recover" | "resume" | "delete"
>;
