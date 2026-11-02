/* Sequential requests bound work and preserve a consistent JMAP state. */
/* oxlint-disable eslint/no-await-in-loop */

import type { CalendarImportFile } from "@opensuite/contracts";
import type {
  CalendarImportStore,
  CalendarImportRow as Row,
} from "@opensuite/db";
import { z } from "zod";
import type { Result } from "neverthrow";
import {
  publicJob,
  assertImportWritable,
  confirmCalendarImport,
  recoverCalendarImport,
} from "./calendar.ts";
import type { Actor } from "./accounts.ts";
import { createJmapAccess, fail, value } from "./jmap-access.ts";

type CalendarStoredEvent = Parameters<
  ImportConnection["client"]["previewCalendarEvent"]
>[1][number];
const eventSchema = z.record(z.string(), z.unknown());

export type ImportDependencies = Parameters<typeof createJmapAccess>[0] & {
  imports: CalendarImportStore;
  parser: {
    splitCalendars(
      files: CalendarImportFile[],
    ): Result<Row[], { kind: "validation"; message: string }>;
    applyParsed(row: Row, parsed: Record<string, unknown>[] | undefined): void;
    previews(
      c: ImportConnection,
      store: CalendarImportStore,
      userId: string,
      accountId: string,
      calendarId: string,
      rows: readonly PreviewInput[],
    ): Promise<PreviewResult>;
  };
};
export type ImportConnection = Awaited<
  ReturnType<ReturnType<typeof createJmapAccess>["connect"]>
>;
type JmapFailure =
  Awaited<
    ReturnType<ImportConnection["client"]["scanCalendarUids"]>
  > extends Result<unknown, infer E>
    ? E
    : never;
export type ImportJob = NonNullable<
  Awaited<ReturnType<CalendarImportStore["get"]>>
>;
type PreviewInput = Pick<Row, "uid" | "file" | "event" | "previewReason">;
type PreviewResult = Result<
  ReturnType<ImportConnection["client"]["previewCalendarEvent"]>[],
  JmapFailure
>;
type Item = ImportJob["items"][number];
type Scan = { state: string; found: CalendarStoredEvent[] };
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
    this.deps.parser.applyParsed(row, result.parsed?.[blob.blobId]);
  }
  preview(
    actor: Actor,
    input: {
      accountId: string;
      calendarId: string;
      files: CalendarImportFile[];
    },
  ) {
    return this.access.run(async () => {
      if (!(await this.deps.imports.hasCapacity(actor.id)))
        return fail("rate_limited");
      const parsed = this.deps.parser.splitCalendars(input.files);
      if (parsed.isErr()) return fail(parsed.error.kind);
      const rows = parsed.value;
      const accountId = await this.resolve(actor, input.accountId);
      const c = await this.connect(actor, accountId);
      await assertImportWritable(c, input.calendarId);
      for (const row of rows) await this.parseRow(c, row);
      const previews = value(
        await this.deps.parser.previews(
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
        JSON.stringify(input.files),
      );
      if (!saved) return fail("rate_limited");
      return publicJob(this.deps.imports, saved);
    });
  }
  list(actor: Actor, accountId: string) {
    return this.access.run(async () => {
      const resolved = await this.resolve(actor, accountId);
      await this.connect(actor, resolved);
      const jobs = await this.deps.imports.list(actor.id, resolved);
      return {
        jobs: jobs.map((job) => publicJob(this.deps.imports, job)),
      };
    });
  }
  get(actor: Actor, id: string) {
    return this.access.run(async () => {
      const stored = await this.job(actor, id);
      await this.connect(actor, stored.accountId);
      return publicJob(this.deps.imports, stored);
    });
  }
  private finish(
    w: Work,
    state: "imported" | "duplicate" | "failed",
    error: string | null,
    eventId: string | null,
    remember = false,
  ) {
    return this.deps.imports.finish(
      w.actor.id,
      w.job.id,
      w.item.id,
      state,
      error,
      eventId,
      remember ? w.identity : undefined,
      w.job.generation,
    );
  }
  private conflict(w: Work, message: string) {
    return this.finish(w, "failed", message, null);
  }
  private async merge(w: Work, match: CalendarStoredEvent) {
    const incoming = eventSchema.safeParse(
      w.desired["recurrenceOverrides"] ?? {},
    );
    const existing = eventSchema.safeParse(match.recurrenceOverrides ?? {});
    if (!incoming.success || !existing.success) return fail("unavailable");
    const changed = Object.keys(incoming.data).find(
      (key) =>
        key in existing.data &&
        w.connection.client.calendarStable(incoming.data[key]) !==
          w.connection.client.calendarStable(existing.data[key]),
    );
    const additions = Object.fromEntries(
      Object.entries(incoming.data).filter(([key]) => !(key in existing.data)),
    );
    if (changed)
      return this.conflict(
        w,
        `Occurrence conflicts with existing event: ${changed}`,
      );
    if (!Object.keys(additions).length)
      return this.finish(
        w,
        w.wasPending ? "duplicate" : "imported",
        null,
        match.id,
      );
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
    const match = w.scan.found.length === 1 ? w.scan.found[0] : undefined;
    const prior = await this.deps.imports.identity(
      w.actor.id,
      w.job.accountId,
      w.job.calendarId,
      w.identity.uid,
    );
    if (
      !match ||
      !match.calendarIds[w.job.calendarId] ||
      (prior &&
        ((prior.eventId !== null && prior.eventId !== match.id) ||
          prior.source !== w.item.file))
    )
      return this.conflict(
        w,
        "UID belongs to another calendar, source, or event",
      );
    if (!prior)
      return this.conflict(
        w,
        "UID already exists without a matching import identity",
      );
    if (!prior.eventId) {
      if (
        !w.wasPending &&
        w.connection.client.calendarEquivalent(w.desired, match)
      )
        return this.finish(w, "imported", null, match.id, true);
      return this.conflict(w, "Uncertain import conflicts with existing event");
    }
    if (!w.connection.client.calendarEquivalent(w.desired, match, false))
      return this.conflict(w, "Existing series differs from the source");
    return this.merge(w, match);
  }
  private async create(w: Work) {
    const reserved = await this.deps.imports.reserve(
      w.actor.id,
      w.job.accountId,
      w.job.calendarId,
      w.identity.uid,
      w.item.file,
    );
    if (!reserved || reserved.source !== w.item.file)
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
      return this.conflict(
        w,
        `Calendar server rejected the event: ${created.error.type}`,
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
      source: item.file,
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
    return this.access.run(async () => {
      const stored = await this.job(actor, id);
      const c = await this.connect(actor, stored.accountId);
      return confirmCalendarImport(this.deps, c, actor, stored);
    });
  }
  recover(
    actor: Actor,
    id: string,
    input: { action: "retarget"; calendarId: string } | { action: "abandon" },
  ) {
    return this.access.run(async () => {
      const stored = await this.job(actor, id);
      const c = await this.connect(actor, stored.accountId);
      return recoverCalendarImport(this.deps, c, actor, stored, input);
    });
  }
  resume(actor: Actor, id: string) {
    return this.access.run(async () => {
      const stored = await this.job(actor, id);
      const c = await this.connect(actor, stored.accountId);
      await assertImportWritable(c, stored.calendarId);
      if (!stored.confirmed || stored.abandoned) return fail("conflict");
      const item = stored.items.find(
        (entry) => entry.state === "processing" || entry.state === "pending",
      );
      if (item) await this.process(actor, stored, c, item);
      return publicJob(this.deps.imports, await this.job(actor, id));
    });
  }
  delete(actor: Actor, id: string) {
    return this.access.run(async () => {
      const stored = await this.job(actor, id);
      await this.connect(actor, stored.accountId);
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
