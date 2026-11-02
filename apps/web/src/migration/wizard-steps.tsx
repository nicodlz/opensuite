import * as React from "react";
import { useId } from "react";
import { Button } from "../ui/button.tsx";
import { TextField } from "../ui/text-field.tsx";
import { sources, type Draft } from "./draft.ts";
import { archiveHint, calendarHint, formatSize } from "./limits.ts";
import { ProblemNotice, Select } from "./parts.tsx";
import { useCalendars, useMailboxes } from "./queries.ts";

type StepProps = {
  draft: Draft;
  update: (change: Partial<Draft>) => void;
};

export function SourceStep({ draft, update }: StepProps) {
  return (
    <fieldset className="migration-sources">
      <legend>What do you want to import?</legend>
      {sources.map((source) => (
        <label className="migration-source" key={source.id}>
          <input
            type="radio"
            name="migration-source"
            value={source.id}
            checked={draft.source === source.id}
            onChange={() => update({ source: source.id })}
          />
          <strong>{source.title}</strong>
          <small>{source.description}</small>
        </label>
      ))}
    </fieldset>
  );
}

function FilePicker({
  label,
  description,
  accept,
  multiple,
  files,
  onFiles,
}: {
  label: string;
  description: string;
  accept: string;
  multiple: boolean;
  files: File[];
  onFiles: (files: File[]) => void;
}) {
  const id = useId();
  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>
        {label}
      </label>
      <p className="field-description" id={`${id}-description`}>
        {description}
      </p>
      <input
        id={id}
        type="file"
        className="migration-file"
        accept={accept}
        multiple={multiple}
        aria-describedby={`${id}-description`}
        onChange={(event) => onFiles([...(event.target.files ?? [])])}
      />
      {files.length > 0 && (
        <ul className="migration-files" aria-label="Chosen files">
          {files.map((file) => (
            <li key={`${file.name}-${String(file.size)}`}>
              {file.name} <small>{formatSize(file.size)}</small>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ArchiveDetails({ draft, update }: StepProps) {
  return (
    <>
      <FilePicker
        label="Mail archive"
        description={archiveHint}
        accept=".mbox,.eml,application/mbox,message/rfc822"
        multiple={false}
        files={draft.archive ? [draft.archive] : []}
        onFiles={(files) => update({ archive: files[0] ?? null })}
      />
      {draft.archive?.name.toLowerCase().endsWith(".mbox") && (
        <fieldset className="migration-choice">
          <legend>MBOX variant</legend>
          <label>
            <input
              type="radio"
              name="mbox-variant"
              checked={draft.variant === "mboxo"}
              onChange={() => update({ variant: "mboxo" })}
            />
            Standard (mboxo), used by Google Takeout and most exporters
          </label>
          <label>
            <input
              type="radio"
              name="mbox-variant"
              checked={draft.variant === "mboxrd"}
              onChange={() => update({ variant: "mboxrd" })}
            />
            mboxrd, only if your exporter says so
          </label>
        </fieldset>
      )}
    </>
  );
}

function ConnectionDetails({ draft, update }: StepProps) {
  const gmail = draft.source === "gmail";
  return (
    <>
      {!gmail && (
        <div className="migration-row">
          <TextField
            label="Server"
            description="Connections always use TLS (IMAPS)."
            placeholder="imap.example.com"
            autoComplete="off"
            value={draft.host}
            onChange={(event) => update({ host: event.target.value })}
          />
          <TextField
            label="Port"
            inputMode="numeric"
            value={draft.port}
            onChange={(event) => update({ port: event.target.value })}
          />
        </div>
      )}
      <TextField
        label={gmail ? "Gmail address" : "Username"}
        type={gmail ? "email" : "text"}
        autoComplete="off"
        spellCheck={false}
        value={draft.username}
        onChange={(event) => update({ username: event.target.value })}
      />
      <TextField
        label="App password"
        type="password"
        autoComplete="new-password"
        description={
          gmail
            ? "Create one in your Google Account under Security, 2-Step Verification, App passwords, and make sure IMAP is on in Gmail. Never use your main Google password; signing in with Google is not available here."
            : "Use an app password if your provider offers one, rather than your main password."
        }
        value={draft.password}
        onChange={(event) => update({ password: event.target.value })}
      />
      <p className="migration-note">
        The password is sent once over a protected connection, stored encrypted
        for this migration only, and deleted when it ends or after 24 hours. It
        is never shown again. Remove the app password at your provider once the
        migration is done.
      </p>
    </>
  );
}

export function DetailsStep({ draft, update }: StepProps) {
  if (draft.source === "archive")
    return <ArchiveDetails draft={draft} update={update} />;
  if (draft.source === "calendar")
    return (
      <FilePicker
        label="Calendar files"
        description={calendarHint}
        accept=".ics,text/calendar"
        multiple
        files={draft.files}
        onFiles={(files) => update({ files })}
      />
    );
  return <ConnectionDetails draft={draft} update={update} />;
}

function LabelMappings({
  draft,
  update,
  mailboxes,
}: StepProps & { mailboxes: { id: string; name: string }[] }) {
  const rows = draft.mappings;
  const change = (id: string, patch: { label?: string; mailboxId?: string }) =>
    update({
      mappings: rows.map((row) => (row.id === id ? { ...row, ...patch } : row)),
    });
  return (
    <fieldset className="migration-mappings">
      <legend>Labels and folders (optional)</legend>
      <p className="field-description">
        {draft.source === "archive"
          ? "Gmail labels in a Takeout archive are applied only when you map them to a mailbox."
          : "Name source folders or Gmail labels, such as Work or [Gmail]/Sent Mail, and choose where they go."}{" "}
        Every message also goes to the destination above; unmapped labels are
        not kept.
      </p>
      {rows.map((row, index) => (
        <div className="migration-mapping" key={row.id}>
          <TextField
            label={`Label ${String(index + 1)}`}
            value={row.label}
            onChange={(event) => change(row.id, { label: event.target.value })}
          />
          <Select
            label={`Mailbox for label ${String(index + 1)}`}
            value={row.mailboxId}
            options={mailboxes}
            onChange={(mailboxId) => change(row.id, { mailboxId })}
          />
          <Button
            type="button"
            variant="ghost"
            size="small"
            aria-label={`Remove label ${String(index + 1)}`}
            onClick={() =>
              update({ mappings: rows.filter((item) => item.id !== row.id) })
            }
          >
            Remove
          </Button>
        </div>
      ))}
      <Button
        type="button"
        variant="secondary"
        size="small"
        onClick={() =>
          update({
            mappings: [
              ...rows,
              { id: crypto.randomUUID(), label: "", mailboxId: "" },
            ],
          })
        }
      >
        Map a label
      </Button>
    </fieldset>
  );
}

export function DestinationStep({ draft, update }: StepProps) {
  const calendar = draft.source === "calendar";
  const mailboxes = useMailboxes();
  const calendars = useCalendars();
  const query = calendar ? calendars : mailboxes;
  if (query.isPending) return <p>Loading destinations…</p>;
  if (query.isError)
    return (
      <ProblemNotice
        error={query.error}
        context="load"
        onRetry={() => void query.refetch()}
      />
    );
  if (calendar)
    return (
      <Select
        label="Import into calendar"
        value={draft.calendarId}
        options={calendars.data?.calendars ?? []}
        onChange={(calendarId) => update({ calendarId })}
      />
    );
  const options = mailboxes.data ?? [];
  return (
    <>
      <Select
        label="Import into mailbox"
        value={draft.mailboxId}
        options={options}
        onChange={(mailboxId) => update({ mailboxId })}
      />
      <LabelMappings draft={draft} update={update} mailboxes={options} />
    </>
  );
}
