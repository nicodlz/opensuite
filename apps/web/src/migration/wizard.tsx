import * as React from "react";
import type { CalendarImportJob } from "@opensuite/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useCallback, useRef, useState, type FormEvent } from "react";
import { Button } from "../ui/button.tsx";
import { requestAutoStart } from "./calendar-runner.ts";
import {
  accountId,
  useMigrationClients,
  type MigrationClients,
} from "./clients.tsx";
import { draftLabels, emptyDraft, stepError, type Draft } from "./draft.ts";
import { checkArchive, tooLargeForRequest } from "./limits.ts";
import { MigrationLayout } from "./layout.tsx";
import { toBase64, type MigrationKind } from "./model.ts";
import { RequestTooLarge } from "./problems.ts";
import { ProblemNotice } from "./parts.tsx";
import { networkMode, useMigrationKey } from "./queries.ts";
import { ReviewStep } from "./wizard-review.tsx";
import { DestinationStep, DetailsStep, SourceStep } from "./wizard-steps.tsx";

const steps = ["Source", "Details", "Destination", "Review"];
const headings = [
  "Choose a source",
  "Source details",
  "Choose the destination",
  "Review and confirm",
];

/** Creates the import described by a reviewed draft. */
async function startImport(
  clients: MigrationClients,
  draft: Draft,
  preview: CalendarImportJob | null,
): Promise<{ kind: MigrationKind; jobId: string }> {
  const mapping = draftLabels(draft);
  const labels = "labels" in mapping ? mapping.labels : {};
  if (draft.source === "calendar") {
    if (!preview) throw new Error("The preview is missing.");
    const job = await clients.calendar.confirm({ jobId: preview.id });
    requestAutoStart(job.id);
    return { kind: "calendar", jobId: job.id };
  }
  if (draft.source === "archive") {
    const archive = draft.archive;
    const check = archive ? checkArchive(archive.name, archive.size) : null;
    if (!archive || !check?.ok) throw new Error("The archive is missing.");
    const report = await clients.mail.create({
      accountId,
      format: check.format,
      variant: draft.variant,
      base64: toBase64(new Uint8Array(await archive.arrayBuffer())),
      mailboxId: draft.mailboxId,
      labels,
    });
    return { kind: "mail", jobId: report.id };
  }
  const username = draft.username.trim();
  const report = await clients.direct.create({
    accountId,
    mailboxId: draft.mailboxId,
    labels,
    source:
      draft.source === "gmail"
        ? { kind: "gmail", username, password: draft.password }
        : {
            kind: "imap",
            host: draft.host.trim(),
            port: Number(draft.port),
            username,
            password: draft.password,
          },
  });
  return { kind: "direct", jobId: report.id };
}

function useWizardRequests(
  draft: Draft,
  preview: CalendarImportJob | null,
  onStarted: () => void,
) {
  const clients = useMigrationClients();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { key } = useMigrationKey();
  // Credentials stay in the draft; the mutations never take them as variables.
  const createPreview = useMutation({
    networkMode,
    mutationFn: async () => {
      const input = {
        accountId,
        calendarId: draft.calendarId,
        files: await Promise.all(
          draft.files.map(async (file) => ({
            name: file.name,
            content: await file.text(),
          })),
        ),
      };
      // Sent anyway, the API would refuse the request before reading it.
      if (tooLargeForRequest(input)) throw new RequestTooLarge();
      return clients.calendar.preview(input);
    },
  });
  const start = useMutation({
    networkMode,
    mutationFn: () => startImport(clients, draft, preview),
    onSettled: () => queryClient.invalidateQueries({ queryKey: key }),
    onSuccess: (job) => {
      onStarted();
      return navigate({
        to: "/settings/migration/$kind/$jobId",
        params: { kind: job.kind, jobId: job.jobId },
      });
    },
  });
  const discard = (job: CalendarImportJob) => {
    // An abandoned preview stays listed and can be discarded later.
    void clients.calendar
      .delete({ jobId: job.id })
      .catch(() => undefined)
      .finally(() => void queryClient.invalidateQueries({ queryKey: key }));
  };
  return { createPreview, start, discard };
}

/** Draft, current step and the moves between steps. */
function useWizard() {
  const [draft, setDraft] = useState(emptyDraft);
  const [step, setStep] = useState(0);
  const [attempted, setAttempted] = useState(false);
  const [preview, setPreview] = useState<CalendarImportJob | null>(null);
  // Focus follows the step once the user has moved, not on arrival. The ref
  // callback is stable, so it runs only when a new step heading mounts.
  const moved = useRef(false);
  const focusHeading = useCallback((node: HTMLHeadingElement | null) => {
    if (node && moved.current) node.focus();
  }, []);
  const update = useCallback((change: Partial<Draft>) => {
    setDraft((current) => ({ ...current, ...change }));
  }, []);
  // The password is forgotten as soon as the import has it.
  const requests = useWizardRequests(draft, preview, () =>
    update({ password: "" }),
  );
  const error = stepError(step, draft);
  function go(next: number) {
    requests.createPreview.reset();
    requests.start.reset();
    setAttempted(false);
    moved.current = true;
    setStep(next);
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    if (error) setAttempted(true);
    else if (step === 3) requests.start.mutate();
    else if (step === 2 && draft.source === "calendar")
      requests.createPreview.mutate(undefined, {
        onSuccess: (job) => {
          setPreview(job);
          go(3);
        },
      });
    else go(step + 1);
  }
  function back() {
    if (preview) requests.discard(preview);
    setPreview(null);
    go(step - 1);
  }
  return {
    draft,
    step,
    preview,
    update,
    focusHeading,
    submit,
    back,
    error: attempted ? error : null,
    busy: requests.createPreview.isPending || requests.start.isPending,
    startFailure: requests.start.error,
    previewFailure: requests.createPreview.error,
  };
}

function StepList({ step }: { step: number }) {
  return (
    <ol className="migration-steps" aria-label="Steps">
      {steps.map((title, index) => (
        <li
          key={title}
          aria-current={index === step ? "step" : undefined}
          className={index < step ? "done" : undefined}
        >
          <span aria-hidden="true">{index + 1}</span> {title}
        </li>
      ))}
    </ol>
  );
}

/** A failed start or preview, which may still have created a migration. */
function StartProblem({
  error,
  context,
}: {
  error: Error | null;
  context: "start" | "preview";
}) {
  if (!error) return null;
  return (
    <>
      <ProblemNotice error={error} context={context} />
      <Link to="/settings/migration">Check your migrations</Link>
    </>
  );
}

function submitLabel(step: number, draft: Draft, busy: boolean) {
  if (busy) return "Working…";
  if (step === 3) return "Start import";
  return step === 2 && draft.source === "calendar"
    ? "Preview import"
    : "Continue";
}

/** Optional assistant: source, details, destination, then a reviewed start. */
export function MigrationWizard() {
  const { draft, step, update, focusHeading, preview, ...wizard } = useWizard();
  return (
    <MigrationLayout
      title="New migration"
      heading="Start a migration"
      subtitle="Choose a source, then check the destination and the limits. Nothing is imported until you confirm."
    >
      <StepList step={step} />
      <form
        className="dependency-card migration-panel"
        aria-labelledby="migration-step"
        noValidate
        onSubmit={wizard.submit}
      >
        <p className="eyebrow">STEP {step + 1} OF 4</p>
        <h2 key={step} id="migration-step" tabIndex={-1} ref={focusHeading}>
          {headings[step]}
        </h2>
        {step === 0 && <SourceStep draft={draft} update={update} />}
        {step === 1 && <DetailsStep draft={draft} update={update} />}
        {step === 2 && <DestinationStep draft={draft} update={update} />}
        {step === 3 && <ReviewStep draft={draft} preview={preview} />}
        {wizard.error && (
          <p className="field-error" role="alert">
            {wizard.error}
          </p>
        )}
        <StartProblem
          error={wizard.startFailure ?? wizard.previewFailure}
          context={wizard.startFailure ? "start" : "preview"}
        />
        <div className="migration-actions">
          {step > 0 ? (
            <Button type="button" variant="secondary" onClick={wizard.back}>
              Back
            </Button>
          ) : (
            <Button asChild variant="secondary">
              <Link to="/settings/migration">Cancel</Link>
            </Button>
          )}
          <Button type="submit" disabled={wizard.busy}>
            {submitLabel(step, draft, wizard.busy)}
          </Button>
        </div>
      </form>
    </MigrationLayout>
  );
}
