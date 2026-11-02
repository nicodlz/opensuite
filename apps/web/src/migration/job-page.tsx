import * as React from "react";
import { Link, useParams } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { Icon } from "../ui/icons.tsx";
import { CalendarActions } from "./calendar-actions.tsx";
import { useCalendarRunner } from "./calendar-runner.ts";
import { calendarLimits } from "./limits.ts";
import { MigrationLayout } from "./layout.tsx";
import { MailActions } from "./mail-actions.tsx";
import {
  calendarPhase,
  calendarRows,
  calendarTally,
  credentialState,
  mailPhase,
  mailRows,
  mailTally,
  outcomeSentence,
  phaseLabels,
  type Phase,
  type ReportRow,
  type Tally,
} from "./model.ts";
import {
  CountList,
  ProblemNotice,
  ProgressBar,
  StatusBadge,
} from "./parts.tsx";
import { useCalendarJob, useMailJob } from "./queries.ts";
import { DownloadReport, ReportTable } from "./report.tsx";

type Loaded = {
  title: string;
  phase: Phase;
  tally: Tally;
  unit: "message" | "event";
  rows: ReportRow[];
  error: string | null;
  limitations: readonly string[];
  actions: ReactNode;
  credential?: string | undefined;
  note?: string | undefined;
};
type Query = {
  isError: boolean;
  error: unknown;
  refetch: () => Promise<unknown>;
};

function Counts({ tally }: { tally: Tally }) {
  return (
    <CountList
      label="Counts"
      entries={[
        ["Imported", tally.imported],
        ["Skipped as already present", tally.skipped],
        ["Uncertain", tally.uncertain],
        ["Failed", tally.failed],
        ["Remaining", tally.remaining],
      ]}
    />
  );
}

/** Progress, outcome, actions and report of one migration. */
function JobFrame({
  jobId,
  query,
  loaded,
  fallbackTitle,
}: {
  jobId: string;
  query: Query;
  loaded: Loaded | undefined;
  fallbackTitle: string;
}) {
  const title = loaded?.title ?? fallbackTitle;
  return (
    <MigrationLayout
      title={title}
      heading={title}
      subtitle="Progress is kept on the server: you can leave this page and come back."
    >
      <Link to="/settings/migration" className="migration-back">
        <Icon name="back" /> All migrations
      </Link>
      {query.isError && (
        <ProblemNotice
          error={query.error}
          context="load"
          onRetry={() => void query.refetch()}
        />
      )}
      {!loaded && !query.isError && <p>Loading the migration…</p>}
      {loaded && <JobDetails jobId={jobId} loaded={loaded} />}
    </MigrationLayout>
  );
}

function JobDetails({ jobId, loaded }: { jobId: string; loaded: Loaded }) {
  const { phase, tally, unit, rows } = loaded;
  return (
    <>
      <section className="dependency-card migration-status" aria-label="Status">
        <output className="migration-status-head">
          <StatusBadge phase={phase} />
        </output>
        <p>{outcomeSentence(phase, tally, unit)}</p>
        {phase !== "preview" && (
          <ProgressBar
            label="Progress"
            done={tally.total - tally.remaining}
            total={tally.total}
          />
        )}
        <Counts tally={tally} />
        {loaded.note && <p className="migration-note">{loaded.note}</p>}
        {loaded.error && (
          <p className="migration-problem" role="alert">
            {loaded.error}
          </p>
        )}
        {loaded.actions}
      </section>
      {loaded.credential && (
        <section className="dependency-card" aria-labelledby="credential">
          <h2 id="credential">Source password</h2>
          <p>{loaded.credential}</p>
          <p className="migration-muted">
            Remove the app password at your provider once you no longer need it.
          </p>
        </section>
      )}
      <section className="migration-section" aria-labelledby="report">
        <div className="migration-report-head">
          <h2 id="report">Report</h2>
          <DownloadReport
            fileName={`migration-${jobId}.csv`}
            heading={[
              ["Migration", loaded.title],
              ["Status", phaseLabels[phase]],
              ["Summary", outcomeSentence(phase, tally, unit)],
            ]}
            rows={rows}
          />
        </div>
        <ReportTable rows={rows} label={`${loaded.title} report`} />
      </section>
      <details className="migration-limits-details">
        <summary>Limits of this migration</summary>
        <ul className="migration-limits">
          {loaded.limitations.map((limit) => (
            <li key={limit}>{limit}</li>
          ))}
        </ul>
      </details>
    </>
  );
}

function MailJob({ kind, jobId }: { kind: "mail" | "direct"; jobId: string }) {
  const query = useMailJob(kind, jobId);
  const report = query.data;
  const direct = report && "source" in report ? report : undefined;
  const title =
    kind === "mail"
      ? "Mail archive import"
      : direct?.source === "gmail"
        ? "Gmail import"
        : "IMAP import";
  const loaded: Loaded | undefined = report && {
    title,
    phase: mailPhase(report),
    tally: mailTally(report),
    unit: "message",
    rows: mailRows(report),
    error: report.error,
    limitations: report.limitations,
    actions: <MailActions kind={kind} report={report} />,
    credential: direct && credentialState(direct),
    note:
      direct && !direct.inventoryReady && !report.error
        ? "Connecting to the source and listing its messages…"
        : undefined,
  };
  return (
    <JobFrame
      jobId={jobId}
      query={query}
      loaded={loaded}
      fallbackTitle={kind === "mail" ? "Mail archive import" : "Mail import"}
    />
  );
}

function CalendarJob({ jobId }: { jobId: string }) {
  const query = useCalendarJob(jobId);
  const runner = useCalendarRunner(jobId);
  const job = query.data;
  const loaded: Loaded | undefined = job && {
    title: "Calendar import",
    phase: runner.running ? "running" : calendarPhase(job),
    tally: calendarTally(job),
    unit: "event",
    rows: calendarRows(job),
    error: null,
    limitations: [
      ...calendarLimits,
      "Events already present are recognised by their identifier and skipped; conflicting and invalid events are not imported.",
    ],
    actions: <CalendarActions job={job} runner={runner} />,
  };
  return (
    <JobFrame
      jobId={jobId}
      query={query}
      loaded={loaded}
      fallbackTitle="Calendar import"
    />
  );
}

const kinds = ["mail", "direct", "calendar"] as const;
/** One migration, addressed by its kind and identifier in the URL. */
export function MigrationJobPage() {
  const params = useParams({ strict: false });
  const kind = kinds.find((item) => item === params.kind);
  const jobId = params.jobId ?? "";
  // Keyed by job, so another job never reuses this one's state.
  if (kind === "calendar") return <CalendarJob key={jobId} jobId={jobId} />;
  if (kind)
    return <MailJob key={`${kind}-${jobId}`} kind={kind} jobId={jobId} />;
  return (
    <MigrationLayout
      title="Migration"
      heading="Migration not found"
      subtitle="This address does not name a migration."
    >
      <Link to="/settings/migration">All migrations</Link>
    </MigrationLayout>
  );
}
