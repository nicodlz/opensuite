import * as React from "react";
import type { Mailbox, Message } from "@opensuite/contracts";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Alias } from "../aliases/client.ts";
import { aliasState } from "../aliases/model.ts";
import { expireSession } from "../auth/components.tsx";
import { Button } from "../ui/button.tsx";
import {
  DropdownContent,
  DropdownItem,
  DropdownMenu,
  DropdownTrigger,
} from "../ui/dropdown-menu.tsx";
import { Icon } from "../ui/icons.tsx";
import { accountId, mailClient } from "./client.ts";
import { formatDate, formatFullDate, initials } from "./model.ts";
import { sanitizeEmail } from "./sanitize.ts";

async function download(blobId: string, name: string) {
  try {
    const { url } = await mailClient.download({ accountId, blobId });
    const response = await fetch(url);
    if (response.status === 401) expireSession();
    if (!response.ok) throw new Error("Download failed");
    const objectUrl = URL.createObjectURL(
      new Blob([await response.blob()], { type: "application/octet-stream" }),
    );
    const link = document.createElement("a");
    link.href = objectUrl;
    link.download = name;
    link.rel = "noopener noreferrer";
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
    return true;
  } catch {
    return false;
  }
}
function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
function formatSize(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.ceil(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Loads inline CID images once per message, as same-origin blob URLs. */
function useInlineImages(message: Message) {
  const [images, setImages] = useState<Record<string, string>>({});
  const parts = message.attachments.filter(
    (part) => part.cid && /^image\/(png|jpeg|gif|webp)$/i.test(part.type),
  );
  const signature = parts.map((part) => `${part.blobId}:${part.cid}`).join();
  useEffect(() => {
    if (!signature) return undefined;
    let cancelled = false;
    const urls: string[] = [];
    void Promise.all(
      parts.map(async (part) => {
        try {
          const { url } = await mailClient.download({
            accountId,
            blobId: part.blobId,
          });
          const target = new URL(url, window.location.origin);
          if (
            target.origin !== window.location.origin &&
            target.protocol !== "blob:"
          )
            return null;
          const response = await fetch(target);
          if (response.status === 401) expireSession();
          if (!response.ok) return null;
          const objectUrl = URL.createObjectURL(
            new Blob([await response.blob()], { type: part.type }),
          );
          if (cancelled) {
            URL.revokeObjectURL(objectUrl);
            return null;
          }
          urls.push(objectUrl);
          return [part.cid?.replace(/^<|>$/g, "") ?? "", objectUrl] satisfies [
            string,
            string,
          ];
        } catch {
          return null;
        }
      }),
    ).then((entries) => {
      if (!cancelled)
        setImages(
          Object.fromEntries(entries.filter((entry) => entry !== null)),
        );
      return undefined;
    });
    return () => {
      cancelled = true;
      for (const url of urls) URL.revokeObjectURL(url);
    };
    // The signature captures every input that changes the loaded parts.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);
  return images;
}

function MessageFrame({ title, srcDoc }: { title: string; srcDoc: string }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(160);
  useEffect(() => {
    const frame = ref.current;
    if (!frame) return undefined;
    let observer: ResizeObserver | undefined;
    function measure() {
      const body = frame?.contentDocument?.body;
      if (!body) return;
      setHeight(Math.ceil(body.scrollHeight) + 8);
      observer?.disconnect();
      observer = new ResizeObserver(() =>
        setHeight(Math.ceil(body.scrollHeight) + 8),
      );
      observer.observe(body);
    }
    frame.addEventListener("load", measure);
    measure();
    return () => {
      frame.removeEventListener("load", measure);
      observer?.disconnect();
    };
  }, []);
  return (
    <iframe
      ref={ref}
      title={title}
      sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
      referrerPolicy="no-referrer"
      srcDoc={srcDoc}
      className="message-frame"
      style={{ height }}
    />
  );
}

function MessageView({
  message,
  expanded,
  onToggle,
  aliases,
}: {
  message: Message;
  aliases: Alias[];
  expanded: boolean;
  onToggle: () => void;
}) {
  const [images, setImages] = useState(false);
  const [attachmentError, setAttachmentError] = useState(false);
  const inlineImages = useInlineImages(message);
  const sender = message.from.name ?? message.from.email;
  const sanitized = useMemo(
    () =>
      expanded
        ? sanitizeEmail(
            message.htmlBody ||
              `<p>${escapeHtml(message.textBody).replaceAll("\n", "<br>")}</p>`,
            images,
            inlineImages,
          )
        : null,
    [expanded, message.htmlBody, message.textBody, images, inlineImages],
  );
  if (!expanded || !sanitized)
    return (
      <button
        type="button"
        className="message collapsed"
        data-message-id={message.id}
        onClick={onToggle}
        aria-expanded="false"
      >
        <span className="message-avatar" aria-hidden="true">
          {initials(sender)}
        </span>
        <strong>{sender}</strong>
        <span className="message-snippet">
          {message.textBody.slice(0, 160)}
        </span>
        <time dateTime={message.sentAt}>{formatDate(message.sentAt)}</time>
      </button>
    );
  const recipients = [...message.to, ...message.cc]
    .map((address) => address.name ?? address.email)
    .join(", ");
  return (
    <article className="message" data-message-id={message.id}>
      <div className="message-header">
        <span className="message-avatar" aria-hidden="true">
          {initials(sender)}
        </span>
        <div className="message-meta">
          <p>
            <strong>{sender}</strong>{" "}
            <span className="message-address">
              &lt;{message.from.email}&gt;
            </span>
          </p>
          <p className="message-recipients">To {recipients || "—"}</p>
          {aliases.map((alias) => (
            <p
              className="message-alias"
              key={alias.id}
              title="Matched from message headers; the actual envelope recipient may be different."
            >
              Matched recipient alias: {alias.address} (
              {alias.enabled ? aliasState(alias) : "Disabled"})
            </p>
          ))}
          {aliases.length > 0 && (
            <p className="message-recipients">
              Matched from message headers; the actual recipient may differ.
            </p>
          )}
        </div>
        <time dateTime={message.sentAt} title={formatFullDate(message.sentAt)}>
          {formatFullDate(message.sentAt)}
        </time>
      </div>
      {sanitized.blockedImages && (
        <div className="image-notice">
          <Icon name="settings" size={16} />
          <span>Remote images are blocked for your privacy.</span>
          <button type="button" onClick={() => setImages(true)}>
            Load images
          </button>
        </div>
      )}
      <MessageFrame
        title={`Message from ${sender}`}
        srcDoc={sanitized.srcDoc}
      />
      {attachmentError && (
        <p role="alert" className="message-error">
          Could not download the attachment. Please try again.
        </p>
      )}
      {message.attachments.length > 0 && (
        <ul className="attachment-list" aria-label="Attachments">
          {message.attachments.map((attachment) => (
            <li key={attachment.id}>
              <button
                type="button"
                onClick={() => {
                  void download(attachment.blobId, attachment.name).then(
                    (success) => setAttachmentError(!success),
                  );
                }}
              >
                <span className="attachment-icon" aria-hidden="true">
                  <Icon name="download" size={16} />
                </span>
                <span className="attachment-name">{attachment.name}</span>
                <small>{formatSize(attachment.size)}</small>
              </button>
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}

export function ReadingPane({
  messages,
  focusMessageId,
  aliasesByMessage,
  folder,
  mailboxes,
  labels,
  starred,
  position,
  onBack,
  onAction,
  onReply,
  onStep,
}: {
  messages: Message[];
  focusMessageId: string | null;
  aliasesByMessage: Record<string, Alias[]>;
  folder: Mailbox | undefined;
  mailboxes: Mailbox[];
  labels: string[];
  starred: boolean;
  position: { index: number; total: number };
  onBack: () => void;
  onAction: (
    change:
      | { type: "archive" }
      | { type: "trash" }
      | { type: "delete" }
      | { type: "move"; mailboxId: string }
      | { type: "read"; value: boolean }
      | { type: "star"; value: boolean }
      | { type: "labels"; labels: string[] },
  ) => void;
  onReply: (message: Message, mode: "reply" | "all" | "forward") => void;
  onStep: (direction: "next" | "previous") => void;
}) {
  const last = messages.at(-1);
  const [open, setOpen] = useState<Set<string>>(
    () =>
      new Set(
        messages
          .filter(
            (message, index) =>
              index === messages.length - 1 ||
              message.id === focusMessageId ||
              message.unread,
          )
          .map((message) => message.id),
      ),
  );
  const messageStack = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (focusMessageId) {
      const target = Array.from(messageStack.current?.children ?? []).find(
        (element) => element.getAttribute("data-message-id") === focusMessageId,
      );
      target?.scrollIntoView({ block: "start" });
    }
  }, [focusMessageId]);
  const inTrash = folder?.role === "trash";
  const custom = mailboxes.filter((item) => item.role === "custom");
  const subject = messages[0]?.subject || "(No subject)";
  return (
    <>
      <div className="reading-toolbar">
        <button
          type="button"
          className="tool-button mobile-back"
          aria-label="Back"
          onClick={onBack}
        >
          <Icon name="back" />
        </button>
        <div className="toolbar-group">
          <button
            type="button"
            className="tool-button"
            aria-label="Archive"
            title="Archive (E)"
            onClick={() => onAction({ type: "archive" })}
          >
            <Icon name="archive" />
          </button>
          <button
            type="button"
            className="tool-button"
            aria-label={inTrash ? "Delete permanently" : "Delete"}
            title={inTrash ? "Delete permanently" : "Delete (#)"}
            onClick={() => onAction({ type: inTrash ? "delete" : "trash" })}
          >
            <Icon name="trash" />
          </button>
          <DropdownMenu>
            <DropdownTrigger asChild>
              <button
                type="button"
                className="tool-button"
                aria-label="Move to folder"
                title="Move to folder"
              >
                <Icon name="move" />
              </button>
            </DropdownTrigger>
            <DropdownContent>
              <div className="menu-label">Move to</div>
              {mailboxes
                .filter(
                  (item) =>
                    item.role !== "custom" &&
                    item.role !== "drafts" &&
                    item.id !== folder?.id,
                )
                .map((item) => (
                  <DropdownItem
                    key={item.id}
                    className="menu-item"
                    onSelect={() =>
                      onAction({ type: "move", mailboxId: item.id })
                    }
                  >
                    {item.name}
                  </DropdownItem>
                ))}
            </DropdownContent>
          </DropdownMenu>
          {custom.length > 0 && (
            <DropdownMenu>
              <DropdownTrigger asChild>
                <button
                  type="button"
                  className="tool-button"
                  aria-label="Labels"
                  title="Labels"
                >
                  <Icon name="label" />
                </button>
              </DropdownTrigger>
              <DropdownContent>
                <div className="menu-label">Labels</div>
                {custom.map((item) => (
                  <DropdownItem
                    key={item.id}
                    className="menu-item"
                    onSelect={() =>
                      onAction({
                        type: "labels",
                        labels: labels.includes(item.id)
                          ? labels.filter((id) => id !== item.id)
                          : [...labels, item.id],
                      })
                    }
                  >
                    <span className="menu-indicator">
                      {labels.includes(item.id) ? "✓" : ""}
                    </span>
                    {item.name}
                  </DropdownItem>
                ))}
              </DropdownContent>
            </DropdownMenu>
          )}
        </div>
        <div className="toolbar-group">
          <button
            type="button"
            className="tool-button"
            aria-label="Mark unread"
            title="Mark unread (Shift+U)"
            onClick={() => onAction({ type: "read", value: false })}
          >
            <Icon name="unread" />
          </button>
          <button
            type="button"
            className={`tool-button ${starred ? "starred" : ""}`}
            aria-label={starred ? "Remove star" : "Add star"}
            aria-pressed={starred}
            title="Star (S)"
            onClick={() => onAction({ type: "star", value: !starred })}
          >
            <Icon name="star" filled={starred} />
          </button>
        </div>
        {position.total > 0 && (
          <div className="toolbar-group toolbar-pager">
            <span>
              {position.index + 1} of {position.total}
            </span>
            <button
              type="button"
              className="tool-button"
              aria-label="Newer conversation"
              title="Newer (K)"
              disabled={position.index <= 0}
              onClick={() => onStep("previous")}
            >
              <Icon name="chevronLeft" />
            </button>
            <button
              type="button"
              className="tool-button"
              aria-label="Older conversation"
              title="Older (J)"
              disabled={position.index >= position.total - 1}
              onClick={() => onStep("next")}
            >
              <Icon name="chevronRight" />
            </button>
          </div>
        )}
      </div>
      <div className="reading-scroll">
        <header className="reading-subject">
          <h2>{subject}</h2>
          <div className="reading-tags">
            {folder && <span className="folder-pill">{folder.name}</span>}
            {labels.map((id) => (
              <span className="folder-pill label" key={id}>
                {mailboxes.find((item) => item.id === id)?.name ?? id}
              </span>
            ))}
            {messages.length > 1 && (
              <button
                type="button"
                className="link-button"
                onClick={() =>
                  setOpen(
                    open.size === messages.length
                      ? new Set(last ? [last.id] : [])
                      : new Set(messages.map((message) => message.id)),
                  )
                }
              >
                {open.size === messages.length ? "Collapse all" : "Expand all"}
              </button>
            )}
          </div>
        </header>
        <div className="message-stack" ref={messageStack}>
          {messages.map((message) => (
            <MessageView
              key={message.id}
              message={message}
              aliases={aliasesByMessage[message.id] ?? []}
              expanded={open.has(message.id) || message.id === last?.id}
              onToggle={() => setOpen(new Set([...open, message.id]))}
            />
          ))}
        </div>
        {last && (
          <div className="reply-actions">
            <Button variant="secondary" onClick={() => onReply(last, "reply")}>
              <Icon name="reply" size={16} /> Reply
            </Button>
            <Button variant="secondary" onClick={() => onReply(last, "all")}>
              <Icon name="replyAll" size={16} /> Reply all
            </Button>
            <Button
              variant="secondary"
              onClick={() => onReply(last, "forward")}
            >
              <Icon name="forward" size={16} /> Forward
            </Button>
          </div>
        )}
      </div>
    </>
  );
}
