import * as React from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Button } from "../ui/button.tsx";
import { Icon } from "../ui/icons.tsx";
import { MigrationLayout } from "./layout.tsx";
import {
  calendarPhase,
  calendarTally,
  type MigrationKind,
  type Phase,
} from "./model.ts";
import { ProblemNotice, StatusBadge } from "./parts.tsx";
import { useMigrationLists } from "./queries.ts";

type Entry = {
  kind: MigrationKind;
  id: string;
  title: string;
  phase: Phase;
  detail: string;
};
const dateFormat = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});
const started = (createdAt: string) =>
  `Started ${dateFormat.format(new Date(createdAt))}`;

function JobList({
  label,
  query,
  entries,
}: {
  label: string;
  query: Pick<UseQueryResult, "isPending" | "isError" | "error" | "refetch">;
  entries: Entry[] | undefined;
}) {
  if (query.isPending && !entries) return <p>Loading {label}…</p>;
  return (
    <>
      {query.isError && (
        <ProblemNotice
          error={query.error}
          context="load"
          onRetry={() => void query.refetch()}
        />
      )}
      {entries?.length === 0 && (
        <p className="migration-muted">No {label} yet.</p>
      )}
      {entries && entries.length > 0 && (
        <ul className="migration-jobs">
          {entries.map((entry) => (
            <li key={`${entry.kind}-${entry.id}`}>
              <Link
                to="/settings/migration/$kind/$jobId"
                params={{ kind: entry.kind, jobId: entry.id }}
                className="migration-job-link"
              >
                <Icon name={entry.kind === "calendar" ? "calendar" : "mail"} />
                <span className="migration-job-text">
                  <strong>{entry.title}</strong>
                  <small>{entry.detail}</small>
                </span>
                <StatusBadge phase={entry.phase} />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function useEntries() {
  const lists = useMigrationLists();
  const mailJobs =
    lists.mail.data && lists.direct.data
      ? [
          ...lists.mail.data.jobs.map((job) => ({
            ...job,
            kind: "mail" as const,
            title: "Mail archive",
          })),
          ...lists.direct.data.jobs.map((job) => ({
            ...job,
            kind: "direct" as const,
            title: job.source === "gmail" ? "Gmail account" : "IMAP server",
          })),
        ]
          .toSorted((a, b) => b.createdAt.localeCompare(a.createdAt))
          .map((job): Entry => ({
            kind: job.kind,
            id: job.id,
            title: job.title,
            phase: job.status,
            detail: started(job.createdAt),
          }))
      : undefined;
  const calendarJobs = lists.calendar.data?.jobs.map((job): Entry => {
    const tally = calendarTally(job);
    const files = [...new Set(job.items.map((item) => item.file))];
    return {
      kind: "calendar",
      id: job.id,
      title: `Calendar: ${files.join(", ") || "no events"}`,
      phase: calendarPhase(job),
      detail: `${String(tally.total - tally.remaining)} of ${String(tally.total)} events processed`,
    };
  });
  // Both mail lists make one list: show the first failure, else the wait.
  const pair = [lists.mail, lists.direct];
  const mailQuery =
    pair.find((query) => query.isError) ??
    pair.find((query) => query.isPending) ??
    lists.mail;
  return { lists, mailQuery, mailJobs, calendarJobs };
}

/** Migrations of the signed-in account and the way to start a new one. */
export function MigrationPage() {
  const { lists, mailQuery, mailJobs, calendarJobs } = useEntries();
  const empty = mailJobs?.length === 0 && calendarJobs?.length === 0;
  const start = (
    <Button asChild>
      <Link to="/settings/migration/new">
        <Icon name="plus" />
        Start a migration
      </Link>
    </Button>
  );
  return (
    <MigrationLayout
      title="Migration"
      heading="Migration"
      subtitle="Bring mail and calendars from another service. Your source is only read, never changed."
      actions={empty ? undefined : start}
    >
      {empty ? (
        <section className="empty-card" aria-labelledby="migration-empty">
          <h2 id="migration-empty">No migrations yet</h2>
          <p>
            Import mail from Gmail, another IMAP server, a Google Takeout, MBOX
            or EML archive, and events from ICS calendar files.
          </p>
          {start}
        </section>
      ) : (
        <>
          <section className="migration-section" aria-labelledby="mail-jobs">
            <h2 id="mail-jobs">Mail</h2>
            <JobList
              label="mail migrations"
              query={mailQuery}
              entries={mailJobs}
            />
          </section>
          <section
            className="migration-section"
            aria-labelledby="calendar-jobs"
          >
            <h2 id="calendar-jobs">Calendar</h2>
            <JobList
              label="calendar migrations"
              query={lists.calendar}
              entries={calendarJobs}
            />
          </section>
        </>
      )}
    </MigrationLayout>
  );
}
