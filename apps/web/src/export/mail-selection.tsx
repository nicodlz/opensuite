import * as React from "react";
import { useEffect, useState } from "react";
import type { Mailbox, Message, ThreadSummary } from "@opensuite/contracts";
import { accountId, mailClient } from "../mail/client.ts";

type Props = {
  busy: boolean;
  setBusy: (value: boolean) => void;
  setNotice: (value: string) => void;
  onExport: (format: "eml" | "mbox", ids: string[]) => void;
};
function useMailboxes(setNotice: Props["setNotice"]) {
  const [mailboxes, setMailboxes] = useState<Mailbox[]>([]);
  const [mailbox, setMailbox] = useState("");
  useEffect(() => {
    void mailClient
      .mailboxes({ accountId })
      .then((result) => {
        setMailboxes(result.mailboxes);
        setMailbox(result.mailboxes[0]?.id ?? "");
        return undefined;
      })
      .catch(() => setNotice("Could not load mailboxes."));
  }, [setNotice]);
  return { mailboxes, mailbox, setMailbox };
}
function useConversations(mailbox: string, setNotice: Props["setNotice"]) {
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  useEffect(() => {
    if (!mailbox) return () => undefined;
    let current = true;
    void mailClient
      .threads({ accountId, mailboxId: mailbox, limit: 100, sort: "newest" })
      .then((result) => {
        if (current) {
          setThreads(result.threads);
          setNextCursor(result.nextCursor);
        }
        return undefined;
      })
      .catch(() => {
        if (current) setNotice("Could not load messages.");
      });
    return () => {
      current = false;
    };
  }, [mailbox, setNotice]);
  async function more() {
    if (!nextCursor) return;
    const result = await mailClient.threads({
      accountId,
      mailboxId: mailbox,
      limit: 100,
      sort: "newest",
      cursor: nextCursor,
    });
    setThreads(result.threads);
    setNextCursor(result.nextCursor);
  }
  return {
    threads,
    nextCursor,
    more,
    clear: () => {
      setThreads([]);
      setNextCursor(null);
    },
  };
}
function useMessages(props: Props) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [selected, setSelected] = useState<{ id: string; label: string }[]>([]);
  async function open(threadId: string) {
    props.setBusy(true);
    try {
      setMessages((await mailClient.thread({ accountId, threadId })).messages);
    } catch {
      props.setNotice("Could not load the conversation.");
    } finally {
      props.setBusy(false);
    }
  }
  const toggle = (id: string) => {
    const message = messages.find((item) => item.id === id);
    setSelected((previous) => {
      if (previous.some((item) => item.id === id))
        return previous.filter((item) => item.id !== id);
      if (!message || previous.length >= 100) return previous;
      return [...previous, { id, label: message.subject || "(No subject)" }];
    });
  };
  return {
    messages,
    selected: selected.map((item) => item.id),
    selectedItems: selected,
    open,
    toggle,
    clear: () => setMessages([]),
  };
}
function MessageOptions({
  messages,
  selected,
  toggle,
}: {
  messages: Message[];
  selected: string[];
  toggle: (id: string) => void;
}) {
  return (
    <fieldset>
      <legend>Messages in conversation</legend>
      {messages.map((message) => (
        <label key={message.id} style={{ display: "block" }}>
          <input
            type="checkbox"
            checked={selected.includes(message.id)}
            disabled={!selected.includes(message.id) && selected.length >= 100}
            onChange={() => toggle(message.id)}
          />{" "}
          {message.subject || "(No subject)"} — {message.sentAt}
        </label>
      ))}
    </fieldset>
  );
}
function MailDownloadButtons({
  busy,
  selected,
  onExport,
}: {
  busy: boolean;
  selected: string[];
  onExport: Props["onExport"];
}) {
  return (
    <>
      <p>{selected.length} selected</p>
      <button
        type="button"
        disabled={busy || selected.length !== 1}
        onClick={() => onExport("eml", selected)}
      >
        Download EML
      </button>{" "}
      <button
        type="button"
        disabled={busy || selected.length < 1 || selected.length > 100}
        onClick={() => onExport("mbox", selected)}
      >
        Download mbox
      </button>
    </>
  );
}
function SelectedMessages({
  items,
  busy,
  toggle,
}: {
  items: { id: string; label: string }[];
  busy: boolean;
  toggle: (id: string) => void;
}) {
  return (
    <ul aria-label="Selected messages">
      {items.map((item) => (
        <li key={item.id}>
          {item.label}{" "}
          <button
            type="button"
            disabled={busy}
            aria-label={`Remove ${item.label} from export`}
            onClick={() => toggle(item.id)}
          >
            Remove
          </button>
        </li>
      ))}
    </ul>
  );
}
function MailChoices({
  messages,
  busy,
  onExport,
}: {
  messages: ReturnType<typeof useMessages>;
  busy: boolean;
  onExport: Props["onExport"];
}) {
  return (
    <>
      <MessageOptions
        messages={messages.messages}
        selected={messages.selected}
        toggle={messages.toggle}
      />
      {messages.selectedItems.length > 0 && (
        <SelectedMessages
          items={messages.selectedItems}
          busy={busy}
          toggle={messages.toggle}
        />
      )}
      <MailDownloadButtons
        busy={busy}
        selected={messages.selected}
        onExport={onExport}
      />
    </>
  );
}
export function MailSelection(props: Props) {
  const folders = useMailboxes(props.setNotice);
  const conversations = useConversations(folders.mailbox, props.setNotice);
  const messages = useMessages(props);
  async function more() {
    props.setBusy(true);
    try {
      await conversations.more();
      messages.clear();
    } catch {
      props.setNotice("Could not load more conversations.");
    } finally {
      props.setBusy(false);
    }
  }
  return (
    <section aria-labelledby="mail-export-heading">
      <h2 id="mail-export-heading">Mail</h2>
      <p>
        Choose messages to export. Up to 100 messages and 20 MB per export; each
        message is limited to 10 MB.
      </p>
      <label>
        Mailbox{" "}
        <select
          disabled={props.busy}
          value={folders.mailbox}
          onChange={(event) => {
            conversations.clear();
            messages.clear();
            folders.setMailbox(event.target.value);
          }}
        >
          {folders.mailboxes.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </select>
      </label>
      <p>
        Open a conversation to select messages. Use Next conversations to browse
        older mail.
      </p>
      <ul>
        {conversations.threads.map((thread) => (
          <li key={thread.id}>
            <button
              type="button"
              disabled={props.busy}
              onClick={() => void messages.open(thread.id)}
            >
              {thread.subject || "(No subject)"}
            </button>
          </li>
        ))}
      </ul>
      {conversations.nextCursor && (
        <button type="button" disabled={props.busy} onClick={() => void more()}>
          Next conversations
        </button>
      )}
      <MailChoices
        messages={messages}
        busy={props.busy}
        onExport={props.onExport}
      />
    </section>
  );
}
