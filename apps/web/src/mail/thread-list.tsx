import * as React from "react";
import type { Mailbox, ThreadSummary } from "@opensuite/contracts";
import { useEffect, useRef } from "react";
import { Icon } from "../ui/icons.tsx";
import { formatDate, initials } from "./model.ts";

export function ThreadRow({
  thread,
  selected,
  checked,
  labels,
  onOpen,
  onCheck,
  onPrefetch,
  onQuick,
}: {
  thread: ThreadSummary;
  selected: boolean;
  checked: boolean;
  labels: Mailbox[];
  onOpen: () => void;
  onCheck: (value: boolean, range: boolean) => void;
  onPrefetch: () => void;
  onQuick: (
    change:
      | { type: "archive" }
      | { type: "trash" }
      | { type: "read"; value: boolean }
      | { type: "star"; value: boolean },
  ) => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (selected) ref.current?.scrollIntoView({ block: "nearest" });
  }, [selected]);
  const person = thread.participants[0];
  const name = person?.name ?? person?.email ?? "Unknown sender";
  return (
    <li
      className={`thread-row ${selected ? "selected" : ""} ${thread.unread ? "unread" : ""} ${checked ? "checked" : ""}`}
    >
      <span className="thread-select">
        <span className="thread-avatar" aria-hidden="true">
          {initials(name)}
        </span>
        <input
          type="checkbox"
          checked={checked}
          aria-label="Select conversation"
          onClick={(event) => {
            event.stopPropagation();
            onCheck(event.currentTarget.checked, event.shiftKey);
          }}
          onChange={() => undefined}
        />
      </span>
      <button
        ref={ref}
        type="button"
        className="thread-open"
        aria-current={selected ? "true" : undefined}
        onClick={onOpen}
        onPointerEnter={onPrefetch}
        onFocus={onPrefetch}
      >
        <span className="thread-top">
          <strong className="thread-sender">
            {name}
            {thread.messageCount > 1 && (
              <span className="thread-count"> {thread.messageCount}</span>
            )}
          </strong>
          {thread.hasAttachment && (
            <Icon name="paperclip" size={14} label="Has attachment" />
          )}
          <time dateTime={thread.updatedAt}>
            {formatDate(thread.updatedAt)}
          </time>
        </span>
        <span className="thread-subject">
          {thread.unread && <span className="visually-hidden">Unread, </span>}
          {thread.subject || "(No subject)"}
        </span>
        <span className="thread-preview">{thread.preview}</span>
        {labels.length > 0 && (
          <span className="thread-tags">
            {labels.map((label) => (
              <span key={label.id}>{label.name}</span>
            ))}
          </span>
        )}
      </button>
      <button
        type="button"
        className={`thread-star ${thread.starred ? "on" : ""}`}
        aria-label={thread.starred ? "Remove star" : "Add star"}
        aria-pressed={thread.starred}
        onClick={() => onQuick({ type: "star", value: !thread.starred })}
      >
        <Icon name="star" size={16} filled={thread.starred} />
      </button>
      <span className="thread-actions">
        <button
          type="button"
          aria-label="Archive conversation"
          title="Archive"
          onClick={() => onQuick({ type: "archive" })}
        >
          <Icon name="archive" size={16} />
        </button>
        <button
          type="button"
          aria-label="Move conversation to trash"
          title="Move to trash"
          onClick={() => onQuick({ type: "trash" })}
        >
          <Icon name="trash" size={16} />
        </button>
        <button
          type="button"
          aria-label={thread.unread ? "Mark as read" : "Mark as unread"}
          title={thread.unread ? "Mark as read" : "Mark as unread"}
          onClick={() => onQuick({ type: "read", value: thread.unread })}
        >
          <Icon name="unread" size={16} />
        </button>
      </span>
    </li>
  );
}
