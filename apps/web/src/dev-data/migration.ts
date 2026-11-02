import {
  CalendarImportJobSchema,
  DIRECT_ABANDON_WARNING,
  DirectMigrationReportSchema,
  migrationReport,
  type CalendarImportItem,
  type CalendarImportJob,
  type migrationCalendarContract,
  type migrationDirectContract,
  type migrationMailContract,
} from "@opensuite/contracts";
import { ORPCError } from "@orpc/client";
import type { ContractRouterClient } from "@orpc/contract";

// Synthetic migrations exist only in the development bundle and only in
// this page's memory; a simulated worker settles one message per step.
// sessionStorage "migration-fixture" selects a scenario: "empty", "denied" or
// "unavailable". Message outcomes follow an "X-Fixture-Outcome" header; a
// direct username starting with "errors" fails some messages. As with the
// real API, a server that is not allowed or the password "wrong-password"
// fails when the worker connects, not when the job is created.
const fixtureMarker = "OPENMAIL_SYNTHETIC_FIXTURE_ONLY";
const stepMs = 700;
const allowed = new Set(["imap.gmail.com:993", "imap.example.test:993"]);
const outcomeValues = ["imported", "duplicate", "failed", "uncertain"] as const;
type Outcome = (typeof outcomeValues)[number];
type MailJob = {
  id: string;
  kind: "mail" | "direct";
  source: "gmail" | "imap";
  status: "queued" | "running" | "completed" | "cancelled" | "attention";
  cancelRequested: boolean;
  error: string | null;
  createdAt: string;
  nextAt: number;
  stored: boolean;
  refused: "host" | "password" | null;
  outcomes: Outcome[] | null;
  items: { status: string; error: string | null; outcome: Outcome }[];
};
type State = { mail: MailJob[]; calendar: CalendarImportJob[] };

const fail = (code: string): never => {
  throw new ORPCError(code);
};
const marker = (message: string) =>
  /^X-Fixture-Outcome: (\w+)/im.exec(message)?.[1];
const toItems = (outcomes: Outcome[]) =>
  outcomes.map((value) => ({ status: "pending", error: null, outcome: value }));
const newJob = (
  kind: MailJob["kind"],
  values: Pick<MailJob, "source" | "refused" | "outcomes" | "items">,
): MailJob => ({
  ...values,
  id: crypto.randomUUID(),
  kind,
  status: "queued",
  cancelRequested: false,
  error: null,
  createdAt: new Date().toISOString(),
  nextAt: Date.now() + stepMs,
  stored: true,
});
const mailJob = (outcomes: Outcome[]) =>
  newJob("mail", {
    source: "imap",
    refused: null,
    outcomes: null,
    items: toItems(outcomes),
  });
/** One earlier, finished import unless the "empty" scenario is selected. */
function seed(): State {
  if (sessionStorage.getItem("migration-fixture") === "empty")
    return { mail: [], calendar: [] };
  const job = mailJob(["imported", "imported", "duplicate"]);
  for (const item of job.items) item.status = item.outcome;
  const createdAt = new Date(Date.now() - 86_400_000).toISOString();
  const done = { status: "completed" as const, stored: false, createdAt };
  return { calendar: [], mail: [{ ...job, ...done }] };
}
const state = seed();
/** Simulated transport and access failures happen before any change. */
const guarded =
  <I, O>(run: (input: I) => O | Promise<O>) =>
  async (input: I): Promise<O> => {
    if (!navigator.onLine)
      throw new TypeError(`Failed to fetch (${fixtureMarker})`);
    const scenario = sessionStorage.getItem("migration-fixture");
    if (scenario === "denied") fail("FORBIDDEN");
    if (scenario === "unavailable") fail("UPSTREAM_UNAVAILABLE");
    return run(input);
  };

function finish(job: MailJob) {
  const has = (status: string) =>
    job.items.some((item) => item.status === status);
  const uncertain = has("uncertain");
  if (job.cancelRequested) job.status = uncertain ? "attention" : "cancelled";
  else job.status = uncertain || has("failed") ? "attention" : "completed";
  if (job.status !== "attention" || job.cancelRequested) job.stored = false;
}
/** The simulated worker: one step per interval elapsed since the last one. */
function advance(job: MailJob, now: number) {
  while (["queued", "running"].includes(job.status) && now >= job.nextAt) {
    job.nextAt += stepMs;
    const item = job.items.find((entry) => entry.status === "pending");
    if (job.refused && !job.cancelRequested) {
      job.status = "attention";
      job.error =
        "Source or destination unavailable; check credentials and resume.";
    } else if (job.outcomes && !job.cancelRequested) {
      job.items = toItems(job.outcomes);
      job.outcomes = null;
    } else if (job.cancelRequested || !item) finish(job);
    else {
      job.status = "running";
      // A failed message succeeds when it is tried again.
      item.status = item.error === null ? item.outcome : "imported";
      item.error =
        item.status === "failed" || item.status === "uncertain"
          ? `Simulated ${item.status} message.`
          : null;
    }
  }
}
function mailReport(job: MailJob) {
  return migrationReport({
    ...job,
    total: job.items.length,
    archive: job.stored ? "stored" : null,
    claimToken: null,
    items: job.items.map((item, index) => ({ ...item, index })),
  });
}
function directReport(job: MailJob) {
  const uncertainCount = job.items.filter(
    (item) => item.status === "uncertain",
  ).length;
  return DirectMigrationReportSchema.parse({
    ...mailReport(job),
    source: job.source,
    inventoryReady: job.outcomes === null,
    recovery:
      job.status === "attention" && !job.cancelRequested
        ? {
            action: "resume",
            message: job.error ?? "Resume to retry.",
          }
        : null,
    abandonment:
      job.status === "attention" && !job.stored && uncertainCount > 0
        ? { uncertainCount, warning: DIRECT_ABANDON_WARNING }
        : null,
  });
}
/** Applies `change` to a stored job of `kind` after letting it progress. */
function update<T>(
  kind: MailJob["kind"],
  id: string,
  change: (job: MailJob) => T,
): T {
  const job =
    state.mail.find((item) => item.id === id && item.kind === kind) ??
    fail("NOT_FOUND");
  advance(job, Date.now());
  return change(job);
}
/** Stores a new job; one job of each kind may be active at a time. */
function addJob(job: MailJob): MailJob {
  state.mail.forEach((item) => advance(item, Date.now()));
  const busy = (item: MailJob) =>
    item.kind === job.kind && ["queued", "running"].includes(item.status);
  if (state.mail.some(busy)) fail("CONFLICT");
  state.mail.push(job);
  return job;
}
function cancel(job: MailJob) {
  if (job.cancelRequested || ["completed", "cancelled"].includes(job.status))
    fail("CONFLICT");
  job.cancelRequested = true;
  job.status = "queued";
  job.nextAt = Date.now();
  if (job.kind === "direct") job.stored = false;
}
function resume(job: MailJob, password: string | undefined) {
  if (job.status !== "attention" || job.cancelRequested) fail("CONFLICT");
  if (password !== undefined) {
    job.stored = true;
    if (job.refused === "password")
      job.refused = password === "wrong-password" ? "password" : null;
  } else if (!job.stored) fail("VALIDATION");
  job.status = "queued";
  job.error = null;
  job.nextAt = Date.now();
  for (const item of job.items)
    if (item.status === "failed") item.status = "pending";
}
function abandon(job: MailJob, count: number) {
  const uncertain = job.items.filter((item) => item.status === "uncertain");
  if (
    job.status !== "attention" ||
    uncertain.length !== count ||
    job.stored !== (job.kind === "mail")
  )
    fail("CONFLICT");
  state.mail = state.mail.filter((item) => item !== job);
  return { abandoned: true as const };
}
function list(kind: MailJob["kind"]) {
  const jobs = state.mail
    .filter((job) => job.kind === kind)
    .map((job) => {
      advance(job, Date.now());
      const { id, status, createdAt, source } = job;
      return { id, status, createdAt, source };
    });
  return jobs.toReversed();
}

/** Operations both server-run mail imports share. */
function jobActions<R>(kind: MailJob["kind"], report: (job: MailJob) => R) {
  type Job = { jobId: string };
  const act = (input: Job, change: (job: MailJob) => void) =>
    update(kind, input.jobId, (job) => {
      change(job);
      return report(job);
    });
  return {
    list: guarded(() => ({ jobs: list(kind) })),
    report: guarded((input: Job) => update(kind, input.jobId, report)),
    cancel: guarded((input: Job) => act(input, cancel)),
    resume: guarded((input: Job & { password?: string | undefined }) =>
      act(input, (job) => resume(job, input.password)),
    ),
    abandon: guarded((input: Job & { uncertainCount: number }) =>
      update(kind, input.jobId, (job) => abandon(job, input.uncertainCount)),
    ),
  };
}

const mail: ContractRouterClient<typeof migrationMailContract> = {
  ...jobActions("mail", mailReport),
  create: guarded((input) => {
    const text = atob(input.base64);
    const messages =
      input.format === "eml" ? [text] : text.split(/^From /m).filter(Boolean);
    if (!messages.length || messages.length > 1000) fail("VALIDATION");
    const outcomes = messages.map(
      (message) =>
        outcomeValues.find((value) => value === marker(message)) ?? "imported",
    );
    return mailReport(addJob(mailJob(outcomes)));
  }),
  remap: guarded(() => fail("CONFLICT")),
};

const direct: ContractRouterClient<typeof migrationDirectContract> = {
  ...jobActions("direct", directReport),
  create: guarded((input) => {
    const source = input.source;
    const server =
      source.kind === "gmail"
        ? "imap.gmail.com:993"
        : `${source.host.toLowerCase()}:${String(source.port)}`;
    const outcomes: Outcome[] = source.username.startsWith("errors")
      ? ["imported", "failed", "uncertain", "duplicate", "imported"]
      : ["imported", "imported", "duplicate", "imported", "imported"];
    const password: MailJob["refused"] =
      source.password === "wrong-password" ? "password" : null;
    const refused: MailJob["refused"] = allowed.has(server) ? password : "host";
    const values = { source: source.kind, refused, outcomes, items: [] };
    return directReport(addJob(newJob("direct", values)));
  }),
  revoke: guarded(() => fail("CONFLICT")),
};

const inFlight =
  "Import abandoned; an in-flight event may have completed or may still complete";
type JobBody = Omit<CalendarImportJob, "previewCounts" | "progress">;
function project(job: JobBody): CalendarImportJob {
  const tally = (key: "preview" | "state", values: string[]) =>
    Object.fromEntries(
      values.map((value) => [
        value,
        job.items.filter((item) => item[key] === value).length,
      ]),
    );
  const { previewCounts, progress } = CalendarImportJobSchema.shape;
  const open = tally("state", ["pending", "processing"]);
  return {
    ...job,
    previewCounts: previewCounts.parse(
      tally("preview", ["new", "update", "duplicate", "conflict", "invalid"]),
    ),
    progress: progress.parse({
      ...tally("state", ["imported", "duplicate", "failed", "abandoned"]),
      total: job.items.length,
      completed:
        job.items.length - (open["pending"] ?? 0) - (open["processing"] ?? 0),
    }),
  };
}
const reasons = {
  invalid: "The event has no UID.",
  conflict: "An event with this UID already exists with different content.",
  duplicate: "This event is already in the calendar.",
  new: null,
};
function previewItem(file: string, chunk: string, index: number) {
  const field = (name: string) =>
    new RegExp(`^${name}:(.*)$`, "m").exec(chunk)?.[1]?.trim() ?? null;
  const [title, uid] = [field("SUMMARY") ?? "", field("UID")];
  const marked = /\[(duplicate|conflict)\]/.exec(title)?.[1];
  const preview =
    uid === null
      ? "invalid"
      : marked === "duplicate" || marked === "conflict"
        ? marked
        : "new";
  const item: CalendarImportItem = {
    index,
    file,
    sourceId: file,
    uid,
    title,
    state: "pending",
    preview,
    previewReason: reasons[preview],
    issues: [],
    error: null,
  };
  return item;
}
function storeCalendar(job: JobBody) {
  const stored = project(job);
  const others = state.calendar.filter((item) => item.id !== job.id);
  state.calendar = [stored, ...others];
  return stored;
}
const findCalendar = (jobId: string) =>
  state.calendar.find((job) => job.id === jobId) ?? fail("NOT_FOUND");
/** Settles one event unless the import was abandoned in the meantime. */
function settle(
  jobId: string,
  index: number,
  next: CalendarImportItem["state"],
  error: string | null,
) {
  const job = findCalendar(jobId);
  const applies = (item: CalendarImportItem) =>
    item.index === index &&
    (next === "processing" || item.state === "processing");
  for (const item of job.items)
    if (applies(item)) Object.assign(item, { state: next, error });
  return storeCalendar(job);
}
function stopped(item: CalendarImportItem): CalendarImportItem {
  if (item.state !== "pending" && item.state !== "processing") return item;
  const error = item.state === "processing" ? inFlight : "Import abandoned";
  return { ...item, state: "abandoned", error };
}

const calendar: ContractRouterClient<typeof migrationCalendarContract> = {
  preview: guarded((input) => {
    const items = input.files
      .flatMap((file) =>
        file.content
          .split("BEGIN:VEVENT")
          .slice(1)
          .map((chunk) => ({ name: file.name, chunk })),
      )
      .map(({ name, chunk }, index) => previewItem(name, chunk, index));
    if (!items.length || items.length > 200) fail("VALIDATION");
    return storeCalendar({
      id: crypto.randomUUID(),
      accountId: "default",
      calendarId: input.calendarId,
      confirmed: false,
      abandoned: false,
      items,
    });
  }),
  list: guarded(() => ({ jobs: state.calendar })),
  get: guarded((input) => findCalendar(input.jobId)),
  delete: guarded((input) => {
    const job = findCalendar(input.jobId);
    if (job.items.some((item) => item.state === "processing")) fail("CONFLICT");
    state.calendar = state.calendar.filter((item) => item.id !== job.id);
    return { success: true as const };
  }),
  confirm: guarded((input) => {
    const job = findCalendar(input.jobId);
    if (job.abandoned) fail("CONFLICT");
    return storeCalendar({ ...job, confirmed: true });
  }),
  recover: guarded((input) => {
    const job = findCalendar(input.jobId);
    // The synthetic calendars cannot disappear, so a retarget never applies.
    if (job.abandoned || input.action === "retarget") fail("CONFLICT");
    const items = job.items.map(stopped);
    return storeCalendar({ ...job, abandoned: true, confirmed: false, items });
  }),
  resume: guarded(async (input) => {
    const job = findCalendar(input.jobId);
    if (!job.confirmed || job.abandoned) fail("CONFLICT");
    const next = job.items.find(
      (item) => item.state === "pending" || item.state === "processing",
    );
    if (!next) return job;
    settle(job.id, next.index, "processing", null);
    await new Promise((resolve) => setTimeout(resolve, 400));
    if (next.preview === "duplicate")
      return settle(job.id, next.index, "duplicate", null);
    if (next.preview === "conflict" || next.preview === "invalid")
      return settle(job.id, next.index, "failed", next.previewReason);
    return settle(job.id, next.index, "imported", null);
  }),
};

export const fakeMigrationClients = { mail, direct, calendar };
