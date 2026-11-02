import * as React from "react";
import type { CalendarImportJob } from "@opensuite/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { Button } from "../ui/button.tsx";
import { useToast } from "../ui/toast.tsx";
import type { useCalendarRunner } from "./calendar-runner.ts";
import { useMigrationClients } from "./clients.tsx";
import { ConfirmAction } from "./confirm.tsx";
import { calendarPhase, type Phase } from "./model.ts";
import { problemOf } from "./problems.ts";
import { ProblemNotice, Select } from "./parts.tsx";
import { networkMode, useCalendars, useMigrationKey } from "./queries.ts";

type Runner = ReturnType<typeof useCalendarRunner>;

function useCalendarRequests(jobId: string, runner: Runner) {
  const clients = useMigrationClients();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const { key } = useMigrationKey();
  const common = {
    networkMode,
    onSuccess: (job: CalendarImportJob) =>
      queryClient.setQueryData([...key, "calendar", jobId], job),
    onSettled: () => queryClient.invalidateQueries({ queryKey: key }),
  };
  const confirm = useMutation({
    ...common,
    mutationFn: () => clients.calendar.confirm({ jobId }),
    onSuccess: (job: CalendarImportJob) => {
      common.onSuccess(job);
      runner.start();
    },
  });
  const abandon = useMutation({
    ...common,
    mutationFn: () => {
      runner.stop();
      return clients.calendar.recover({ jobId, action: "abandon" });
    },
  });
  const retarget = useMutation({
    ...common,
    mutationFn: (calendarId: string) =>
      clients.calendar.recover({ jobId, action: "retarget", calendarId }),
    onSuccess: (job: CalendarImportJob) => {
      common.onSuccess(job);
      // The missing calendar is replaced: its earlier errors no longer apply.
      runner.clear();
      confirm.reset();
    },
  });
  const remove = useMutation({
    networkMode,
    mutationFn: () => clients.calendar.delete({ jobId }),
    onSuccess: async () => {
      toast.notify({ message: "Removed from your migrations." });
      // Leave first, so the removed job is not requested again.
      await navigate({ to: "/settings/migration" });
      queryClient.removeQueries({ queryKey: [...key, "calendar", jobId] });
      await queryClient.invalidateQueries({ queryKey: key });
    },
  });
  return { confirm, abandon, retarget, remove };
}

function RetargetForm({
  onSubmit,
  busy,
}: {
  onSubmit: (calendarId: string) => void;
  busy: boolean;
}) {
  const calendars = useCalendars();
  const [calendarId, setCalendarId] = useState("");
  return (
    <form
      className="migration-inline-form"
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        if (calendarId) onSubmit(calendarId);
      }}
    >
      <Select
        label="Another calendar"
        value={calendarId}
        options={calendars.data?.calendars ?? []}
        onChange={setCalendarId}
      />
      <Button type="submit" disabled={busy || !calendarId}>
        Preview with this calendar
      </Button>
    </form>
  );
}

type Requests = ReturnType<typeof useCalendarRequests>;

/** The buttons that apply to the import's current phase. */
function PhaseButtons({
  phase,
  settled,
  busy,
  runner,
  requests,
}: {
  phase: Phase;
  settled: boolean;
  busy: boolean;
  runner: Runner;
  requests: Requests;
}) {
  const moving = phase === "paused" || phase === "running";
  const preview = phase === "preview";
  return (
    <div className="migration-actions">
      {preview && (
        <Button disabled={busy} onClick={() => requests.confirm.mutate()}>
          Start import
        </Button>
      )}
      {phase === "paused" && (
        <Button disabled={busy} onClick={runner.start}>
          Continue import
        </Button>
      )}
      {phase === "running" && (
        <Button variant="secondary" onClick={runner.stop}>
          Pause
        </Button>
      )}
      {moving && (
        <ConfirmAction
          label="Cancel import"
          title="Cancel this import?"
          description="Events already imported stay in your calendar. The rest are not imported; an event being imported right now may still complete."
          confirmLabel="Cancel import"
          disabled={busy}
          onConfirm={() => requests.abandon.mutate()}
        />
      )}
      {!moving && settled && (
        <ConfirmAction
          label={preview ? "Discard preview" : "Remove from list"}
          title={preview ? "Discard this preview?" : "Remove this report?"}
          description="Events already in your calendar are not changed; only this migration and its report are removed."
          confirmLabel="Remove"
          disabled={busy}
          onConfirm={() => requests.remove.mutate()}
        />
      )}
    </div>
  );
}

/** Start, pause, continue, retarget, cancel and removal of a calendar import. */
export function CalendarActions({
  job,
  runner,
}: {
  job: CalendarImportJob;
  runner: Runner;
}) {
  const requests = useCalendarRequests(job.id, runner);
  const phase = runner.running ? "running" : calendarPhase(job);
  const busy = Object.values(requests).some((request) => request.isPending);
  const failure = [
    runner.error,
    ...Object.values(requests).map((request) => request.error),
  ].find((error) => error !== null);
  const missing =
    failure !== undefined && problemOf(failure, navigator.onLine) === "target";
  return (
    <div className="migration-job-actions">
      {phase === "paused" && (
        <p className="migration-note">
          Calendar imports run while this page is open. If you leave, come back
          here and continue.
        </p>
      )}
      {runner.waiting && (
        <output className="migration-note">
          The server limits how fast events are imported. The import continues
          in about a minute.
        </output>
      )}
      <PhaseButtons
        phase={phase}
        settled={!job.items.some((item) => item.state === "processing")}
        busy={busy}
        runner={runner}
        requests={requests}
      />
      {missing && (
        <RetargetForm
          busy={busy}
          onSubmit={(calendarId) => requests.retarget.mutate(calendarId)}
        />
      )}
      {failure !== undefined && (
        <ProblemNotice error={failure} context="calendar" />
      )}
    </div>
  );
}
