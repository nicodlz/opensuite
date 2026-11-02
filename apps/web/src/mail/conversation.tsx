import * as React from "react";
import type { Mailbox, Message } from "@opensuite/contracts";
import { useEffect, useRef, useState } from "react";
import type { Alias } from "../aliases/client.ts";
import { Button } from "../ui/button.tsx";
import { Icon } from "../ui/icons.tsx";
import { MessageView } from "./reading-pane.tsx";

/** Subject, folder and labels, with a control to open every message. */
function ConversationHeader({
  subject,
  folder,
  mailboxes,
  labels,
  allOpen,
  onToggleAll,
}: {
  subject: string;
  folder: Mailbox | undefined;
  mailboxes: Mailbox[];
  labels: string[];
  /** Undefined when there is a single message. */
  allOpen: boolean | undefined;
  onToggleAll: () => void;
}) {
  return (
    <header className="reading-subject">
      <h2 tabIndex={-1}>{subject}</h2>
      <div className="reading-tags">
        {folder && <span className="folder-pill">{folder.name}</span>}
        {labels.map((id) => (
          <span className="folder-pill label" key={id}>
            {mailboxes.find((item) => item.id === id)?.name ?? id}
          </span>
        ))}
        {allOpen !== undefined && (
          <button type="button" className="link-button" onClick={onToggleAll}>
            {allOpen ? "Collapse all" : "Expand all"}
          </button>
        )}
      </div>
    </header>
  );
}

function ReplyActions({
  message,
  onReply,
}: {
  message: Message;
  onReply: (message: Message, mode: "reply" | "all" | "forward") => void;
}) {
  return (
    <div className="reply-actions">
      <Button variant="secondary" onClick={() => onReply(message, "reply")}>
        <Icon name="reply" size={16} /> Reply
      </Button>
      <Button variant="secondary" onClick={() => onReply(message, "all")}>
        <Icon name="replyAll" size={16} /> Reply all
      </Button>
      <Button variant="secondary" onClick={() => onReply(message, "forward")}>
        <Icon name="forward" size={16} /> Forward
      </Button>
    </div>
  );
}

/** The messages of one conversation; give it a `key` per conversation. */
export function Conversation({
  messages,
  focusMessageId,
  aliasesByMessage,
  folder,
  mailboxes,
  labels,
  onReply,
}: {
  messages: Message[];
  focusMessageId: string | null;
  aliasesByMessage: Record<string, Alias[]>;
  folder: Mailbox | undefined;
  mailboxes: Mailbox[];
  labels: string[];
  onReply: (message: Message, mode: "reply" | "all" | "forward") => void;
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
  const allOpen = open.size === messages.length;
  return (
    <div className="reading-scroll">
      <ConversationHeader
        subject={messages[0]?.subject || "(No subject)"}
        folder={folder}
        mailboxes={mailboxes}
        labels={labels}
        allOpen={messages.length > 1 ? allOpen : undefined}
        onToggleAll={() =>
          setOpen(
            allOpen
              ? new Set(last ? [last.id] : [])
              : new Set(messages.map((message) => message.id)),
          )
        }
      />
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
      {last && <ReplyActions message={last} onReply={onReply} />}
    </div>
  );
}
