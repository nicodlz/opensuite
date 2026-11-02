import * as React from "react";
import { Icon } from "../ui/icons.tsx";
import { plural } from "./model.ts";

export type Attachment = { blobId: string; name: string; size?: number };

export function formatSize(bytes: number) {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${String(Math.ceil(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** The title bar a composer collapses to. */
export function MinimizedComposer({
  title,
  busy,
  onRestore,
  onClose,
}: {
  title: string;
  busy: boolean;
  onRestore: () => void;
  onClose: () => void;
}) {
  return (
    <section className="composer minimized" aria-label="Compose message">
      <div className="compose-header">
        <button type="button" className="compose-title" onClick={onRestore}>
          {title}
        </button>
        <div>
          <button type="button" aria-label="Restore draft" onClick={onRestore}>
            <Icon name="maximize" size={16} />
          </button>
          <button
            type="button"
            aria-label="Save and close draft"
            disabled={busy}
            onClick={onClose}
          >
            <Icon name="close" size={16} />
          </button>
        </div>
      </div>
    </section>
  );
}

/** Attached files and uploads in progress; nothing when there are none. */
export function AttachmentList({
  attachments,
  uploading,
  onRemove,
}: {
  attachments: Attachment[];
  uploading: number;
  onRemove: (blobId: string) => void;
}) {
  if (!attachments.length && !uploading) return null;
  return (
    <ul className="compose-attachments" aria-label="Attachments">
      {attachments.map((item) => (
        <li key={item.blobId}>
          <Icon name="paperclip" size={14} />
          <span title={item.name}>{item.name}</span>
          {item.size !== undefined && <small>{formatSize(item.size)}</small>}
          <button
            type="button"
            aria-label={`Remove ${item.name}`}
            onClick={() => onRemove(item.blobId)}
          >
            <Icon name="close" size={14} />
          </button>
        </li>
      ))}
      {uploading > 0 && (
        <li className="uploading">Uploading {plural(uploading, "file")}…</li>
      )}
    </ul>
  );
}
