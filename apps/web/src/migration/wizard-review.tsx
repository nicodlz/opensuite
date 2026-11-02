import * as React from "react";
import {
  MAIL_ARCHIVE_LIMIT,
  MAIL_IMPORT_LIMITATIONS,
  type CalendarImportJob,
} from "@opensuite/contracts";
import { draftLabels, sources, type Draft } from "./draft.ts";
import { calendarLimits, directLimits, formatSize } from "./limits.ts";
import { calendarRows } from "./model.ts";
import { CountList } from "./parts.tsx";
import { ReportTable } from "./report.tsx";
import { useCalendars, useMailboxes } from "./queries.ts";

function Summary({ draft }: { draft: Draft }) {
  const mailboxes = useMailboxes().data ?? [];
  const calendars = useCalendars().data?.calendars ?? [];
  const name = (id: string) =>
    [...mailboxes, ...calendars].find((item) => item.id === id)?.name ?? id;
  const mapping = draftLabels(draft);
  const labels = Object.entries("labels" in mapping ? mapping.labels : {});
  const source = sources.find((item) => item.id === draft.source)?.title ?? "";
  const files =
    draft.source === "archive" && draft.archive ? [draft.archive] : draft.files;
  return (
    <dl className="migration-summary">
      <dt>Source</dt>
      <dd>{source}</dd>
      {draft.source === "gmail" || draft.source === "imap" ? (
        <>
          <dt>Account</dt>
          <dd>
            {draft.username.trim()}
            {draft.source === "imap" &&
              ` on ${draft.host.trim()}:${draft.port.trim()}`}
          </dd>
        </>
      ) : (
        <>
          <dt>{files.length === 1 ? "File" : "Files"}</dt>
          <dd>
            {files
              .map((file) => `${file.name} (${formatSize(file.size)})`)
              .join(", ")}
          </dd>
        </>
      )}
      <dt>Destination</dt>
      <dd>
        {name(draft.source === "calendar" ? draft.calendarId : draft.mailboxId)}
      </dd>
      {labels.length > 0 && (
        <>
          <dt>Mapped labels</dt>
          <dd>
            {labels
              .map(([label, mailboxId]) => `${label} → ${name(mailboxId)}`)
              .join(", ")}
          </dd>
        </>
      )}
    </dl>
  );
}

function SizeMeter({ size }: { size: number }) {
  return (
    <div className="migration-meter">
      <label>
        Archive size: {formatSize(size)} of {formatSize(MAIL_ARCHIVE_LIMIT)}
        <meter min={0} max={MAIL_ARCHIVE_LIMIT} value={size} />
      </label>
    </div>
  );
}

function PreviewCounts({ preview }: { preview: CalendarImportJob }) {
  const counts = preview.previewCounts;
  return (
    <CountList
      label="Preview"
      entries={[
        ["New", counts.new],
        ["Updates", counts.update],
        ["Already present", counts.duplicate],
        ["Conflicts", counts.conflict],
        ["Invalid", counts.invalid],
      ]}
    />
  );
}

/** Everything that will happen, and its limits, before anything is imported. */
export function ReviewStep({
  draft,
  preview,
}: {
  draft: Draft;
  preview: CalendarImportJob | null;
}) {
  const limits =
    draft.source === "archive"
      ? MAIL_IMPORT_LIMITATIONS
      : draft.source === "calendar"
        ? calendarLimits
        : directLimits;
  return (
    <>
      <Summary draft={draft} />
      {draft.source === "archive" && draft.archive && (
        <SizeMeter size={draft.archive.size} />
      )}
      {preview && (
        <>
          <h3>What the import will do</h3>
          <PreviewCounts preview={preview} />
          {preview.previewCounts.conflict + preview.previewCounts.invalid >
            0 && (
            <p className="migration-note">
              Conflicting and invalid events will not be imported; they are
              listed in the report.
            </p>
          )}
          <ReportTable rows={calendarRows(preview)} label="Preview" />
        </>
      )}
      <h3>Limits</h3>
      <ul className="migration-limits">
        {limits.map((limit) => (
          <li key={limit}>{limit}</li>
        ))}
      </ul>
      <p className="migration-note">
        Nothing is deleted or changed at the source. Items already imported stay
        in Esuno if you cancel later.
      </p>
    </>
  );
}
