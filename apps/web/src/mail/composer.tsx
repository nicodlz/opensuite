import * as React from "react";
import type { DraftContent } from "@opensuite/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "../ui/button.tsx";
import { Icon } from "../ui/icons.tsx";
import { accountId, mailClient } from "./client.ts";
import { parseAddresses } from "./model.ts";

export type ComposerState = {
  key: string;
  draftId: string | null;
  content: DraftContent;
};
type Attachment = { blobId: string; name: string; size?: number };
type Fields = {
  from: string;
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  textBody: string;
  attachments: Attachment[];
};

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
const joinAddresses = (list: { email: string }[]) =>
  list.map((address) => address.email).join(", ");
function toContent(base: DraftContent, fields: Fields): DraftContent {
  return {
    ...base,
    from: fields.from || undefined,
    to: parseAddresses(fields.to).addresses,
    cc: parseAddresses(fields.cc).addresses,
    bcc: parseAddresses(fields.bcc).addresses,
    subject: fields.subject,
    textBody: fields.textBody,
    htmlBody: fields.textBody
      ? `<p>${escapeHtml(fields.textBody).replaceAll("\n", "<br>")}</p>`
      : "",
    attachmentBlobIds: fields.attachments.map((item) => item.blobId),
  };
}
const isEmpty = (fields: Fields) =>
  !fields.to.trim() &&
  !fields.cc.trim() &&
  !fields.bcc.trim() &&
  !fields.subject.trim() &&
  !fields.textBody.trim() &&
  fields.attachments.length === 0;
function readBase64(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      if (typeof reader.result === "string")
        resolve(reader.result.replace(/^data:[^,]*,/, ""));
      else reject(new Error("Read failed"));
    });
    reader.addEventListener("error", () =>
      reject(reader.error ?? new Error("Read failed")),
    );
    reader.readAsDataURL(file);
  });
}
const hasFiles = (event: DragEvent) =>
  event.dataTransfer?.types.includes("Files") ?? false;
function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function Composer({
  state,
  from,
  aliases,
  minimized,
  onMinimize,
  onClose,
  onNotice,
  onSaved,
  onDraftId,
}: {
  state: ComposerState;
  from: string | undefined;
  aliases: { id: string; address: string }[];
  minimized: boolean;
  onMinimize: (value: boolean) => void;
  onClose: () => void;
  onNotice: (value: string) => void;
  onSaved: () => void;
  /** Reports the id each save gives the draft (JMAP recreates it). */
  onDraftId?: (id: string) => void;
}) {
  const [initial] = useState<Fields>(() => ({
    from: state.content.from ?? "",
    to: joinAddresses(state.content.to),
    cc: joinAddresses(state.content.cc),
    bcc: joinAddresses(state.content.bcc),
    subject: state.content.subject,
    textBody: state.content.textBody,
    attachments: state.content.attachmentBlobIds.map((blobId) => ({
      blobId,
      name: "Attachment",
    })),
  }));
  const [fields, setFields] = useState<Fields>(initial);
  const [showCopies, setShowCopies] = useState(
    state.content.cc.length > 0 || state.content.bcc.length > 0,
  );
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [status, setStatus] = useState<"" | "saving" | "saved">("");
  const [error, setError] = useState("");
  // Compare in the form the composer saves, so opening a draft or a reply
  // without changing it writes nothing.
  const saved = useRef({
    id: state.draftId,
    snapshot: JSON.stringify(toContent(state.content, initial)),
  });
  const working = useRef(false);
  const draftIdListener = useRef(onDraftId);
  useEffect(() => {
    draftIdListener.current = onDraftId;
  });
  const queue = useRef<Promise<void>>(Promise.resolve());
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const toRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // Replies start in the body; new messages start with recipients.
    if (state.content.to.length) bodyRef.current?.focus();
    else toRef.current?.focus();
  }, [state.content.to.length]);

  const persist = useCallback((value: DraftContent) => {
    const run = queue.current.then(async () => {
      const snapshot = JSON.stringify(value);
      if (saved.current.id && snapshot === saved.current.snapshot)
        return undefined;
      setStatus("saving");
      const result = saved.current.id
        ? await mailClient.updateDraft({
            accountId,
            draftId: saved.current.id,
            draft: value,
          })
        : await mailClient.createDraft({ accountId, draft: value });
      saved.current = { id: result.id, snapshot };
      draftIdListener.current?.(result.id);
      setStatus("saved");
      setError((current) =>
        current.startsWith("Could not save") ? "" : current,
      );
      return undefined;
    });
    queue.current = run.catch(() => undefined);
    return run;
  }, []);

  useEffect(() => {
    if (busy) return undefined;
    const value = toContent(state.content, fields);
    if (JSON.stringify(value) === saved.current.snapshot) return undefined;
    if (!saved.current.id && isEmpty(fields)) return undefined;
    const timer = window.setTimeout(() => {
      persist(value).catch(() => {
        setStatus("");
        setError("Could not save this draft. Try again.");
      });
    }, 1500);
    return () => window.clearTimeout(timer);
  }, [fields, busy, state.content, persist]);

  async function close() {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    try {
      const value = toContent(state.content, fields);
      if (
        saved.current.id ||
        (!isEmpty(fields) && JSON.stringify(value) !== saved.current.snapshot)
      ) {
        await persist(value);
        onSaved();
      }
      onClose();
    } catch {
      working.current = false;
      setError("Could not save this draft. Try again.");
      setBusy(false);
    }
  }
  async function send() {
    setError("");
    const recipients = [fields.to, fields.cc, fields.bcc].map(parseAddresses);
    const invalid = recipients.flatMap((item) => item.invalid);
    if (invalid.length) {
      setError(`Check these addresses: ${invalid.join(", ")}`);
      return;
    }
    if (!recipients[0]?.addresses.length) {
      setError("Add at least one recipient.");
      toRef.current?.focus();
      return;
    }
    if (uploading) {
      setError("Wait for attachments to finish uploading.");
      return;
    }
    // One send per draft, whatever triggers it (button, Ctrl+Enter, repeat).
    if (working.current) return;
    working.current = true;
    setBusy(true);
    try {
      await persist(toContent(state.content, fields));
      const id = saved.current.id;
      if (!id) throw new Error("Draft was not saved");
      await mailClient.send({ accountId, draftId: id });
      // Accepted for delivery only: the outbound relay may still refuse it,
      // and then a delivery report arrives in the inbox.
      onNotice(
        "Message queued. If it cannot be delivered, you should receive a report.",
      );
      onSaved();
      onClose();
    } catch {
      working.current = false;
      setError(
        "Sending could not be confirmed. Check Sent before trying again.",
      );
      setBusy(false);
    }
  }
  async function discard() {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    try {
      await queue.current;
      if (saved.current.id)
        await mailClient.deleteDraft({
          accountId,
          draftId: saved.current.id,
        });
      onNotice("Draft discarded.");
      onSaved();
      onClose();
    } catch {
      working.current = false;
      setError("Could not discard this draft.");
      setBusy(false);
    }
  }
  async function uploadOne(file: File) {
    setUploading((count) => count + 1);
    try {
      const attachment = await mailClient.upload({
        accountId,
        name: file.name,
        type: file.type || "application/octet-stream",
        base64: await readBase64(file),
      });
      setFields((value) => ({
        ...value,
        attachments: [
          ...value.attachments,
          { blobId: attachment.blobId, name: file.name, size: file.size },
        ],
      }));
    } catch {
      setError(`Could not upload ${file.name}.`);
    } finally {
      setUploading((count) => count - 1);
    }
  }
  const upload = (files: Iterable<File>) =>
    Promise.all(Array.from(files, uploadOne));
  const latest = useRef({ send, upload, onMinimize, expanded });
  useEffect(() => {
    latest.current = { send, upload, onMinimize, expanded };
  });
  // Native listeners keep the section a plain landmark for assistive tech.
  const sectionRef = useCallback((section: HTMLElement | null) => {
    if (!section) return undefined;
    const controller = new AbortController();
    const options = { signal: controller.signal };
    section.addEventListener(
      "keydown",
      (event) => {
        if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          if (!event.repeat) void latest.current.send();
        } else if (event.key === "Escape") {
          event.preventDefault();
          if (latest.current.expanded) setExpanded(false);
          else latest.current.onMinimize(true);
        }
      },
      options,
    );
    section.addEventListener(
      "dragenter",
      (event) => {
        if (hasFiles(event)) setDragging(true);
      },
      options,
    );
    section.addEventListener(
      "dragover",
      (event) => {
        if (!hasFiles(event) || !event.dataTransfer) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
      },
      options,
    );
    section.addEventListener(
      "dragleave",
      (event) => {
        if (
          !(event.relatedTarget instanceof Node) ||
          !section.contains(event.relatedTarget)
        )
          setDragging(false);
      },
      options,
    );
    section.addEventListener(
      "drop",
      (event) => {
        if (!hasFiles(event) || !event.dataTransfer) return;
        event.preventDefault();
        setDragging(false);
        void latest.current.upload(event.dataTransfer.files);
      },
      options,
    );
    return () => controller.abort();
  }, []);

  if (minimized)
    return (
      <section className="composer minimized" aria-label="Compose message">
        <div className="compose-header">
          <button
            type="button"
            className="compose-title"

            onClick={() => onMinimize(false)}
          >
            {fields.subject || "New message"}
          </button>
          <div>
            <button
              type="button"
              aria-label="Restore draft"
              onClick={() => onMinimize(false)}
            >
              <Icon name="maximize" size={16} />
            </button>
            <button
              type="button"
              aria-label="Save and close draft"
              disabled={busy}
              onClick={() => {
                void close();
              }}
            >
              <Icon name="close" size={16} />
            </button>
          </div>
        </div>
      </section>
    );
  return (
    <>
      {expanded && (
        <div
          className="composer-backdrop"
          aria-hidden="true"
          onClick={() => setExpanded(false)}
        />
      )}
      <section
        className={`composer ${expanded ? "expanded" : ""} ${dragging ? "dragging" : ""}`}
        aria-label="Compose message"
        ref={sectionRef}
      >
        <div className="compose-header">
          <strong className="compose-title">
            {fields.subject || "New message"}
          </strong>
          <div>
            <button
              type="button"
              aria-label="Minimize draft"
              onClick={() => onMinimize(true)}
            >
              <Icon name="minimize" size={16} />
            </button>
            <button
              type="button"
              aria-label={expanded ? "Restore size" : "Maximize draft"}
              onClick={() => setExpanded(!expanded)}
            >
              <Icon name={expanded ? "restore" : "maximize"} size={16} />
            </button>
            <button
              type="button"
              aria-label="Save and close draft"
              disabled={busy}
              onClick={() => {
                void close();
              }}
            >
              <Icon name="close" size={16} />
            </button>
          </div>
        </div>
        <div className="compose-fields">
          {from && (
            <label className="compose-row compose-from">
              <span>From</span>
              <select
                value={fields.from || from}
                onChange={(event) =>
                  setFields({
                    ...fields,
                    from: event.target.value === from ? "" : event.target.value,
                  })
                }
              >
                <option value={from}>{from}</option>
                {fields.from &&
                  fields.from !== from &&
                  !aliases.some((alias) => alias.address === fields.from) && (
                    <option value={fields.from}>
                      {fields.from} (unavailable)
                    </option>
                  )}
                {aliases
                  .filter((alias) => alias.address !== from)
                  .map((alias) => (
                    <option key={alias.id} value={alias.address}>
                      {alias.address}
                    </option>
                  ))}
              </select>
            </label>
          )}
          <div className="compose-row">
            <label htmlFor={`to-${state.key}`}>To</label>
            <input
              ref={toRef}
              id={`to-${state.key}`}
              value={fields.to}
              onChange={(event) =>
                setFields({ ...fields, to: event.target.value })
              }
              placeholder="Recipients, separated by commas"
              autoComplete="email"
            />
            {!showCopies && (
              <button
                type="button"
                className="compose-copies"
                onClick={() => setShowCopies(true)}
              >
                Cc Bcc
              </button>
            )}
          </div>
          {showCopies && (
            <>
              <label className="compose-row">
                <span>Cc</span>
                <input
                  value={fields.cc}
                  onChange={(event) =>
                    setFields({ ...fields, cc: event.target.value })
                  }
                />
              </label>
              <label className="compose-row">
                <span>Bcc</span>
                <input
                  value={fields.bcc}
                  onChange={(event) =>
                    setFields({ ...fields, bcc: event.target.value })
                  }
                />
              </label>
            </>
          )}
          <label className="compose-row">
            <span className="visually-hidden">Subject</span>
            <input
              className="compose-subject"
              value={fields.subject}
              placeholder="Subject"
              onChange={(event) =>
                setFields({ ...fields, subject: event.target.value })
              }
            />
          </label>
          <label className="visually-hidden" htmlFor={`body-${state.key}`}>
            Message body
          </label>
          <textarea
            ref={bodyRef}
            id={`body-${state.key}`}
            value={fields.textBody}
            onChange={(event) =>
              setFields({ ...fields, textBody: event.target.value })
            }
            placeholder="Write your message…"
          />
          {(fields.attachments.length > 0 || uploading > 0) && (
            <ul className="compose-attachments" aria-label="Attachments">
              {fields.attachments.map((item) => (
                <li key={item.blobId}>
                  <Icon name="paperclip" size={14} />
                  <span>{item.name}</span>
                  {item.size !== undefined && (
                    <small>{formatSize(item.size)}</small>
                  )}
                  <button
                    type="button"
                    aria-label={`Remove ${item.name}`}
                    onClick={() =>
                      setFields({
                        ...fields,
                        attachments: fields.attachments.filter(
                          (other) => other.blobId !== item.blobId,
                        ),
                      })
                    }
                  >
                    <Icon name="close" size={14} />
                  </button>
                </li>
              ))}
              {uploading > 0 && (
                <li className="uploading" aria-live="polite">
                  Uploading {uploading} file{uploading > 1 ? "s" : ""}…
                </li>
              )}
            </ul>
          )}
          {error && (
            <p className="compose-error" role="alert">
              {error}
            </p>
          )}
        </div>
        <div className="compose-footer">
          <Button
            disabled={busy}
            onClick={() => {
              void send();
            }}
            aria-keyshortcuts="Control+Enter Meta+Enter"
          >
            Send <Icon name="send" size={16} />
          </Button>
          <label className="compose-tool" title="Attach files">
            <Icon name="paperclip" />
            <span className="visually-hidden">Attach files</span>
            <input
              type="file"
              multiple
              onChange={(event) => {
                const files = event.target.files;
                if (files) void upload([...files]);
                event.target.value = "";
              }}
            />
          </label>
          <span className="compose-status" aria-live="polite">
            {status === "saving"
              ? "Saving…"
              : status === "saved"
                ? "Draft saved"
                : ""}
          </span>
          <button
            type="button"
            className="compose-tool"
            onClick={() => {
              void discard();
            }}
            disabled={busy}
            aria-label="Discard draft"
            title="Discard draft"
          >
            <Icon name="trash" />
          </button>
        </div>
        {dragging && (
          <div className="compose-drop" aria-hidden="true">
            <Icon name="paperclip" size={28} />
            Drop files to attach
          </div>
        )}
      </section>
    </>
  );
}
