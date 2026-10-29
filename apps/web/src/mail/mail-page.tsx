import * as React from "react";
import { themeChoices, type ThemeChoice } from "@opensuite/design-tokens";
import type {
  Draft,
  DraftContent,
  MailAction,
  MailSearch,
  Message,
  ThreadSummary,
} from "@opensuite/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useReducer, useRef, useState } from "react";
import { Button } from "../ui/button.tsx";
import { Dialog, DialogContent } from "../ui/dialog.tsx";
import {
  DropdownContent,
  DropdownItemIndicator,
  DropdownMenu,
  DropdownRadioGroup,
  DropdownRadioItem,
  DropdownTrigger,
} from "../ui/dropdown-menu.tsx";
import { accountId, mailClient } from "./client.ts";
import {
  emptyDraft,
  formatDate,
  initials,
  replyDraft,
  selectionReducer,
} from "./model.ts";
import { sanitizeEmail } from "./sanitize.ts";

const key = ["mail", accountId];
const folderIcons: Record<string, string> = {
  inbox: "▣",
  drafts: "▤",
  sent: "➤",
  archive: "▱",
  trash: "♲",
  work: "◇",
};
function themeInitial(): ThemeChoice {
  const value = localStorage.getItem("opensuite-theme");
  return value === "light" || value === "dark" ? value : "system";
}
function splitAddresses(value: string) {
  return value
    .split(",")
    .map((email) => email.trim())
    .filter(Boolean)
    .map((email) => ({ email }));
}
function contentOf(draft: Draft): DraftContent {
  const { id: _id, ...content } = draft;
  return content;
}

export function MailPage() {
  const queryClient = useQueryClient();
  const [theme, setTheme] = useState<ThemeChoice>(themeInitial);
  const [folder, setFolder] = useState("inbox");
  const [search, setSearch] = useState("");
  const [filters, setFilters] = useState<MailSearch>({});
  const [showFilters, setShowFilters] = useState(false);
  const [sort, setSort] = useState<"newest" | "oldest">("newest");
  const [cursor, setCursor] = useState<string | undefined>();
  const [selected, dispatch] = useReducer(selectionReducer, null);
  const [reading, setReading] = useState(false);
  const [composers, setComposers] = useState<Draft[]>([]);
  const [help, setHelp] = useState(false);
  const [notice, setNotice] = useState("");
  const [undo, setUndo] = useState<{
    threadId: string;
    mailboxId: string;
  } | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (theme === "system") delete document.documentElement.dataset["theme"];
    else document.documentElement.dataset["theme"] = theme;
    localStorage.setItem("opensuite-theme", theme);
  }, [theme]);
  const identity = useQuery({
    queryKey: [...key, "identity"],
    queryFn: () => mailClient.identity({ accountId }),
  });
  const mailboxes = useQuery({
    queryKey: [...key, "mailboxes"],
    queryFn: () => mailClient.mailboxes({ accountId }),
  });
  const draftList = useQuery({
    queryKey: [...key, "drafts"],
    queryFn: () => mailClient.drafts({ accountId }),
  });
  const listKey = [...key, "threads", folder, search, filters, sort, cursor];
  const threads = useQuery({
    queryKey: listKey,
    queryFn: () =>
      mailClient.threads({
        accountId,
        mailboxId: folder,
        limit: 30,
        sort,
        search: { ...filters, ...(search ? { query: search } : {}) },
        ...(cursor ? { cursor } : {}),
      }),
  });
  const detail = useQuery({
    queryKey: [...key, "thread", selected],
    queryFn: () => {
      if (!selected) throw new Error("No conversation selected");
      return mailClient.thread({ accountId, threadId: selected });
    },
    enabled: Boolean(selected && reading),
  });
  const list = threads.data?.threads ?? [];
  const current = detail.data?.messages.at(-1);
  const invalidate = () => queryClient.invalidateQueries({ queryKey: key });
  const action = useMutation({
    mutationFn: ({
      threadId,
      change,
    }: {
      threadId: string;
      change: MailAction;
    }) => mailClient.action({ accountId, threadId, action: change }),
    onMutate: async ({ threadId, change }) => {
      await queryClient.cancelQueries({ queryKey: listKey });
      const previous = queryClient.getQueryData<{
        threads: ThreadSummary[];
        nextCursor: string | null;
      }>(listKey);
      if (previous)
        queryClient.setQueryData(listKey, {
          ...previous,
          threads: previous.threads.flatMap((thread) => {
            if (thread.id !== threadId) return [thread];
            if (
              change.type === "archive" ||
              change.type === "trash" ||
              change.type === "move"
            )
              return [];
            if (change.type === "read")
              return [{ ...thread, unread: !change.value }];
            if (change.type === "star")
              return [{ ...thread, starred: change.value }];
            return [{ ...thread, labels: change.labels }];
          }),
        });
      return { previous };
    },
    onError: (_error, variables, context) => {
      if (context?.previous)
        queryClient.setQueryData(listKey, context.previous);
      setUndo(null);
      if (
        variables.change.type === "move" ||
        variables.change.type === "archive" ||
        variables.change.type === "trash"
      ) {
        dispatch({ type: "select", id: variables.threadId });
        setReading(true);
      }
      setNotice("Could not update the conversation. Please try again.");
    },
    onSettled: () => invalidate(),
  });
  async function compose(content: DraftContent = emptyDraft()) {
    try {
      const draft = await mailClient.createDraft({ accountId, draft: content });
      setComposers((items) => [...items, draft]);
      void invalidate();
    } catch {
      setNotice("Could not create a draft. Please try again.");
    }
  }
  function openThread(id: string) {
    dispatch({ type: "select", id });
    setReading(true);
    const thread = list.find((item) => item.id === id);
    if (thread?.unread)
      action.mutate({ threadId: id, change: { type: "read", value: true } });
  }
  function perform(change: MailAction) {
    if (!selected) return;
    if (
      change.type === "archive" ||
      change.type === "trash" ||
      change.type === "move"
    ) {
      setUndo({ threadId: selected, mailboxId: folder });
      setNotice(
        change.type === "archive"
          ? "Conversation archived."
          : change.type === "trash"
            ? "Conversation moved to trash."
            : "Conversation moved.",
      );
      setReading(false);
      dispatch({ type: "select", id: null });
    }
    action.mutate({ threadId: selected, change });
  }
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (
        event.defaultPrevented ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        event.repeat ||
        help ||
        composers.length
      )
        return;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable ||
          ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) ||
          (target.tagName === "BUTTON" && event.key === "Enter"))
      )
        return;
      switch (event.key) {
        case "j":
        case "k":
          event.preventDefault();
          dispatch({
            type: event.key === "j" ? "next" : "previous",
            threads: list,
          });
          setReading(false);
          break;
        case "Enter":
          if (selected) {
            event.preventDefault();
            openThread(selected);
          }
          break;
        case "e":
          if (selected) {
            event.preventDefault();
            perform({ type: "archive" });
          }
          break;
        case "#":
          if (selected) {
            event.preventDefault();
            perform({ type: "trash" });
          }
          break;
        case "r":
        case "a":
        case "f":
          if (current) {
            event.preventDefault();
            void compose(
              replyDraft(
                current,
                event.key === "r"
                  ? "reply"
                  : event.key === "a"
                    ? "all"
                    : "forward",
                identity.data?.address.email,
              ),
            );
          }
          break;
        case "c":
          event.preventDefault();
          void compose();
          break;
        case "/":
          event.preventDefault();
          searchRef.current?.focus();
          break;
        case "?":
          event.preventDefault();
          setHelp(true);
          break;
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });
  function selectFolder(id: string) {
    setFolder(id);
    setCursor(undefined);
    dispatch({ type: "select", id: null });
    setReading(false);
  }
  const folderName =
    mailboxes.data?.mailboxes.find((item) => item.id === folder)?.name ??
    "Mail";
  return (
    <div className="mail-app">
      <a href="#mail-main" className="skip-link">
        Skip to content
      </a>
      <aside className="mail-sidebar">
        <Link to="/mail" className="mail-brand">
          <img src="/mark.svg" alt="" />
          <span>OpenSuite</span>
        </Link>
        <details className="product-switcher">
          <summary className="mail-product">
            <span className="mail-product-icon">✉</span>
            <span>
              <strong>Mail</strong>
              <small>Personal workspace</small>
            </span>
            <span aria-hidden="true">⌄</span>
          </summary>
          <nav aria-label="Products" className="product-switcher-menu">
            <Link to="/calendar">Calendar</Link>
            <Link to="/contacts">Contacts</Link>
            <Link to="/drive">Drive</Link>
            <Link to="/">System status</Link>
          </nav>
        </details>
        <Button
          className="mail-compose"
          onClick={() => {
            void compose();
          }}
        >
          <span aria-hidden="true">＋</span> New message <kbd>C</kbd>
        </Button>
        <nav aria-label="Mail folders" className="mail-folders">
          <p className="mail-nav-label">YOUR MAIL</p>
          {mailboxes.data?.mailboxes
            .filter((item) => item.role !== "custom")
            .map((item) => (
              <button
                type="button"
                key={item.id}
                className={
                  folder === item.id ? "mail-folder active" : "mail-folder"
                }
                aria-current={folder === item.id ? "page" : undefined}
                onClick={() => selectFolder(item.id)}
              >
                <span aria-hidden="true">{folderIcons[item.id] ?? "▱"}</span>
                <span>{item.name}</span>
                {item.unread > 0 && <strong>{item.unread}</strong>}
              </button>
            ))}
          <p className="mail-nav-label label-title">LABELS</p>
          {mailboxes.data?.mailboxes
            .filter((item) => item.role === "custom")
            .map((item) => (
              <button
                type="button"
                key={item.id}
                className={
                  folder === item.id ? "mail-folder active" : "mail-folder"
                }
                onClick={() => selectFolder(item.id)}
              >
                <span aria-hidden="true">◇</span>
                <span>{item.name}</span>
                {item.unread > 0 && <strong>{item.unread}</strong>}
              </button>
            ))}
        </nav>
        <div className="mail-sidebar-bottom">
          <Link to="/calendar">▦ &nbsp; Calendar</Link>
          <Link to="/contacts">♙ &nbsp; Contacts</Link>
          <Link to="/drive">◇ &nbsp; Drive</Link>
          <Link to="/">◉ &nbsp; System status</Link>
        </div>
      </aside>
      <div className="mail-body">
        <header className="mail-topbar">
          <div className="mail-search">
            <span aria-hidden="true">⌕</span>
            <label className="visually-hidden" htmlFor="mail-search">
              Search mail
            </label>
            <input
              ref={searchRef}
              id="mail-search"
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                setCursor(undefined);
              }}
              placeholder="Search your mail"
            />
            <button
              type="button"
              aria-label="Search filters"
              onClick={() => setShowFilters(!showFilters)}
            >
              ☷
            </button>
          </div>
          <div className="mail-top-actions">
            <Button
              variant="ghost"
              size="small"
              aria-label="Keyboard shortcuts"
              onClick={() => setHelp(true)}
            >
              ?
            </Button>
            <DropdownMenu>
              <DropdownTrigger asChild>
                <Button
                  variant="ghost"
                  size="small"
                  aria-label="Account and appearance menu"
                >
                  <span className="avatar">O</span>
                  <span className="account-text">My account</span> ⌄
                </Button>
              </DropdownTrigger>
              <DropdownContent>
                <div className="menu-label">Appearance</div>
                <DropdownRadioGroup
                  value={theme}
                  onValueChange={(value) => {
                    if (
                      value === "system" ||
                      value === "light" ||
                      value === "dark"
                    )
                      setTheme(value);
                  }}
                >
                  {themeChoices.map((choice) => (
                    <DropdownRadioItem
                      key={choice}
                      value={choice}
                      className="menu-item"
                    >
                      <span className="menu-indicator">
                        <DropdownItemIndicator>✓</DropdownItemIndicator>
                      </span>
                      {choice === "system"
                        ? "Use system theme"
                        : `${choice.charAt(0).toUpperCase()}${choice.slice(1)} theme`}
                    </DropdownRadioItem>
                  ))}
                </DropdownRadioGroup>
              </DropdownContent>
            </DropdownMenu>
          </div>
        </header>
        {showFilters && (
          <div className="search-filters">
            <label>
              From
              <input
                value={filters.from ?? ""}
                onChange={(event) =>
                  setFilters({ ...filters, from: event.target.value })
                }
              />
            </label>
            <label>
              To
              <input
                value={filters.to ?? ""}
                onChange={(event) =>
                  setFilters({ ...filters, to: event.target.value })
                }
              />
            </label>
            <label>
              After
              <input
                type="date"
                onChange={(event) =>
                  setFilters({
                    ...filters,
                    after: event.target.value
                      ? `${event.target.value}T00:00:00.000Z`
                      : undefined,
                  })
                }
              />
            </label>
            <label>
              Before
              <input
                type="date"
                onChange={(event) =>
                  setFilters({
                    ...filters,
                    before: event.target.value
                      ? `${event.target.value}T23:59:59.999Z`
                      : undefined,
                  })
                }
              />
            </label>
            <label>
              <input
                type="checkbox"
                checked={filters.unread === true}
                onChange={(event) =>
                  setFilters({
                    ...filters,
                    unread: event.target.checked ? true : undefined,
                  })
                }
              />{" "}
              Unread
            </label>
            <label>
              <input
                type="checkbox"
                checked={filters.hasAttachment === true}
                onChange={(event) =>
                  setFilters({
                    ...filters,
                    hasAttachment: event.target.checked ? true : undefined,
                  })
                }
              />{" "}
              Has attachment
            </label>
            <Button
              variant="ghost"
              size="small"
              onClick={() => {
                setFilters({});
                setCursor(undefined);
              }}
            >
              Clear filters
            </Button>
          </div>
        )}
        <main id="mail-main" tabIndex={-1} className="mail-content">
          <div className="mail-heading">
            <div>
              <p className="mail-eyebrow">YOUR WORKSPACE / MAIL</p>
              <h1>{folderName}</h1>
              <p className="mail-heading-subtitle">
                Your conversations, all in one place.
              </p>
            </div>
            <Button
              className="mobile-compose"
              onClick={() => {
                void compose();
              }}
            >
              ＋ New message
            </Button>
          </div>
          <div className={`mail-panes ${reading ? "show-reading" : ""}`}>
            <section className="thread-list" aria-label="Conversations">
              <div className="list-heading">
                <div>
                  <strong>Conversations</strong>
                  <span>{threads.data?.threads.length ?? 0} shown</span>
                </div>
                <label>
                  <span className="visually-hidden">Sort conversations</span>
                  <select
                    value={sort}
                    onChange={(event) => {
                      setSort(
                        event.target.value === "oldest" ? "oldest" : "newest",
                      );
                      setCursor(undefined);
                    }}
                  >
                    <option value="newest">Newest</option>
                    <option value="oldest">Oldest</option>
                  </select>
                </label>
              </div>
              {folder === "drafts" ? (
                <div>
                  {draftList.data?.drafts.length ? (
                    draftList.data.drafts.map((draft) => (
                      <button
                        className="draft-row"
                        key={draft.id}
                        type="button"
                        onClick={() =>
                          setComposers((items) =>
                            items.some((item) => item.id === draft.id)
                              ? items
                              : [...items, draft],
                          )
                        }
                      >
                        <strong>{draft.subject || "(No subject)"}</strong>
                        <span>
                          {draft.to
                            .map((address) => address.email)
                            .join(", ") || "No recipients"}
                        </span>
                      </button>
                    ))
                  ) : (
                    <div className="mail-empty">
                      <strong>No drafts yet</strong>
                      <p>Start a message and it will appear here.</p>
                    </div>
                  )}
                </div>
              ) : threads.isPending ? (
                <div
                  className="skeleton-list"
                  aria-label="Loading conversations"
                >
                  <span />
                  <span />
                  <span />
                </div>
              ) : threads.isError || mailboxes.isError ? (
                <div className="mail-empty" role="alert">
                  <strong>
                    {navigator.onLine
                      ? "Mail is unavailable"
                      : "You’re offline"}
                  </strong>
                  <p>Check your connection and try again.</p>
                  <Button
                    variant="secondary"
                    onClick={() => {
                      void threads.refetch();
                      void mailboxes.refetch();
                    }}
                  >
                    Retry
                  </Button>
                </div>
              ) : !list.length ? (
                <div className="mail-empty">
                  <div className="empty-icon">✉</div>
                  <strong>Nothing here yet</strong>
                  <p>
                    {search || Object.keys(filters).length
                      ? "Try a different search."
                      : "This folder is clear."}
                  </p>
                </div>
              ) : (
                <div>
                  {list.map((thread) => (
                    <button
                      type="button"
                      key={thread.id}
                      className={`thread-row ${selected === thread.id ? "selected" : ""} ${thread.unread ? "unread" : ""}`}
                      onClick={() => openThread(thread.id)}
                    >
                      <span className="thread-avatar">
                        {initials(
                          thread.participants[0]?.name ??
                            thread.participants[0]?.email ??
                            "?",
                        )}
                      </span>
                      <span className="thread-copy">
                        <span className="thread-top">
                          <strong>
                            {thread.participants[0]?.name ??
                              thread.participants[0]?.email}
                          </strong>
                          <time dateTime={thread.updatedAt}>
                            {formatDate(thread.updatedAt)}
                          </time>
                        </span>
                        <span className="thread-subject">
                          {thread.subject || "(No subject)"}{" "}
                          {thread.messageCount > 1 && (
                            <small>({thread.messageCount})</small>
                          )}
                        </span>
                        <span className="thread-preview">{thread.preview}</span>
                        <span className="thread-tags">
                          {thread.labels.map((label) => (
                            <span key={label}>{label}</span>
                          ))}
                          {thread.starred && (
                            <span aria-label="Starred">★</span>
                          )}
                        </span>
                      </span>
                      {thread.unread && (
                        <span className="unread-dot" aria-label="Unread" />
                      )}
                    </button>
                  ))}
                </div>
              )}
              {(cursor || threads.data?.nextCursor) && (
                <div className="pagination">
                  <Button
                    variant="ghost"
                    size="small"
                    disabled={!cursor}
                    onClick={() => setCursor(undefined)}
                  >
                    First page
                  </Button>
                  <Button
                    variant="ghost"
                    size="small"
                    disabled={!threads.data?.nextCursor}
                    onClick={() =>
                      setCursor(threads.data?.nextCursor ?? undefined)
                    }
                  >
                    Next page →
                  </Button>
                </div>
              )}
            </section>
            <section className="reading-pane" aria-label="Reading pane">
              {reading && selected ? (
                detail.isPending ? (
                  <div className="skeleton-list" aria-label="Loading message">
                    <span />
                    <span />
                    <span />
                  </div>
                ) : detail.isError ? (
                  <div className="mail-empty" role="alert">
                    <strong>Could not load this conversation</strong>
                    <Button
                      variant="secondary"
                      onClick={() => {
                        void detail.refetch();
                      }}
                    >
                      Retry
                    </Button>
                  </div>
                ) : (
                  <>
                    <div className="reading-toolbar">
                      <Button
                        className="mobile-back"
                        variant="ghost"
                        size="small"
                        onClick={() => setReading(false)}
                      >
                        ← Back
                      </Button>
                      <div className="toolbar-buttons">
                        <Button
                          variant="ghost"
                          size="small"
                          aria-label="Archive"
                          onClick={() => perform({ type: "archive" })}
                        >
                          ▱ <span>Archive</span>
                        </Button>
                        <Button
                          variant="ghost"
                          size="small"
                          aria-label="Delete"
                          onClick={() => perform({ type: "trash" })}
                        >
                          ♲ <span>Delete</span>
                        </Button>
                        <label className="move-label">
                          <span className="visually-hidden">
                            Move to folder
                          </span>
                          <select
                            value=""
                            onChange={(event) => {
                              if (event.target.value)
                                perform({
                                  type: "move",
                                  mailboxId: event.target.value,
                                });
                            }}
                          >
                            <option value="">Move to</option>
                            {mailboxes.data?.mailboxes
                              .filter(
                                (item) =>
                                  item.role !== "custom" &&
                                  item.role !== "drafts" &&
                                  item.id !== folder,
                              )
                              .map((item) => (
                                <option key={item.id} value={item.id}>
                                  {item.name}
                                </option>
                              ))}
                          </select>
                        </label>
                        <Button
                          variant="ghost"
                          size="small"
                          aria-label="Mark unread"
                          onClick={() =>
                            perform({ type: "read", value: false })
                          }
                        >
                          ✉
                        </Button>
                        <label className="move-label">
                          <span className="visually-hidden">
                            Add or remove label
                          </span>
                          <select
                            value=""
                            onChange={(event) => {
                              const label = event.target.value;
                              const existing =
                                list.find((item) => item.id === selected)
                                  ?.labels ?? [];
                              if (label)
                                perform({
                                  type: "labels",
                                  labels: existing.includes(label)
                                    ? existing.filter((id) => id !== label)
                                    : [...existing, label],
                                });
                            }}
                          >
                            <option value="">Labels</option>
                            {mailboxes.data?.mailboxes
                              .filter((item) => item.role === "custom")
                              .map((item) => (
                                <option key={item.id} value={item.id}>
                                  {list
                                    .find((thread) => thread.id === selected)
                                    ?.labels.includes(item.id)
                                    ? "✓ "
                                    : ""}
                                  {item.name}
                                </option>
                              ))}
                          </select>
                        </label>
                        <Button
                          variant="ghost"
                          size="small"
                          aria-label="Toggle star"
                          onClick={() =>
                            perform({
                              type: "star",
                              value: !list.find((item) => item.id === selected)
                                ?.starred,
                            })
                          }
                        >
                          ☆
                        </Button>
                      </div>
                    </div>
                    <div className="reading-scroll">
                      <div className="reading-subject">
                        <p className="mail-eyebrow">CONVERSATION</p>
                        <h2>
                          {detail.data.messages[0]?.subject || "(No subject)"}
                        </h2>
                        <span className="folder-pill">{folderName}</span>
                      </div>
                      {detail.data.messages.map((message) => (
                        <MessageView key={message.id} message={message} />
                      ))}
                      {current && (
                        <div className="reply-actions">
                          <Button
                            variant="secondary"
                            onClick={() => {
                              void compose(
                                replyDraft(
                                  current,
                                  "reply",
                                  identity.data?.address.email,
                                ),
                              );
                            }}
                          >
                            ↶ Reply
                          </Button>
                          <Button
                            variant="ghost"
                            onClick={() => {
                              void compose(
                                replyDraft(
                                  current,
                                  "all",
                                  identity.data?.address.email,
                                ),
                              );
                            }}
                          >
                            Reply all
                          </Button>
                          <Button
                            variant="ghost"
                            onClick={() => {
                              void compose(
                                replyDraft(
                                  current,
                                  "forward",
                                  identity.data?.address.email,
                                ),
                              );
                            }}
                          >
                            Forward →
                          </Button>
                        </div>
                      )}
                    </div>
                  </>
                )
              ) : (
                <div className="reading-empty">
                  <div className="reading-illustration">✉</div>
                  <h2>Your space to focus</h2>
                  <p>Select a conversation to read it here.</p>
                  <span>MAIL, MADE SIMPLE</span>
                </div>
              )}
            </section>
          </div>
        </main>
        {notice && (
          <output className="mail-notice">
            {notice}{" "}
            {undo && (
              <button
                type="button"
                disabled={action.isPending}
                onClick={() => {
                  action.mutate({
                    threadId: undo.threadId,
                    change: { type: "move", mailboxId: undo.mailboxId },
                  });
                  setUndo(null);
                  setNotice("Conversation restored.");
                }}
              >
                Undo
              </button>
            )}
            <button
              type="button"
              aria-label="Dismiss notification"
              onClick={() => {
                setNotice("");
                setUndo(null);
              }}
            >
              ×
            </button>
          </output>
        )}
        <div className="compose-dock">
          {composers.map((draft) => (
            <Composer
              key={draft.id}
              draft={draft}
              onClose={() => {
                setComposers((items) =>
                  items.filter((item) => item.id !== draft.id),
                );
                void invalidate();
              }}
              onNotice={setNotice}
              onRefresh={() => {
                void invalidate();
              }}
            />
          ))}
        </div>
        <Dialog open={help} onOpenChange={setHelp}>
          <DialogContent
            title="Keyboard shortcuts"
            description="Use these shortcuts when you are not typing."
          >
            <div className="shortcut-grid">
              <span>Next / previous conversation</span>
              <kbd>J / K</kbd>
              <span>Open conversation</span>
              <kbd>Enter</kbd>
              <span>Archive / delete</span>
              <kbd>E / #</kbd>
              <span>Reply / reply all / forward</span>
              <kbd>R / A / F</kbd>
              <span>New message</span>
              <kbd>C</kbd>
              <span>Search</span>
              <kbd>/</kbd>
              <span>Show shortcuts</span>
              <kbd>?</kbd>
            </div>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
}

async function download(blobId: string, name: string) {
  try {
    const { url } = await mailClient.download({ accountId, blobId });
    const response = await fetch(url);
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
function MessageView({ message }: { message: Message }) {
  const [images, setImages] = useState(false);
  const [attachmentError, setAttachmentError] = useState(false);
  const sanitized = sanitizeEmail(
    message.htmlBody ||
      `<p>${escapeHtml(message.textBody).replaceAll("\n", "<br>")}</p>`,
    images,
  );
  return (
    <article className="message">
      <div className="message-header">
        <span className="message-avatar">
          {initials(message.from.name ?? message.from.email)}
        </span>
        <div>
          <strong>{message.from.name ?? message.from.email}</strong>
          <span>&lt;{message.from.email}&gt;</span>
          <p>
            To{" "}
            {message.to
              .map((address) => address.name ?? address.email)
              .join(", ")}
          </p>
        </div>
        <time dateTime={message.sentAt}>{formatDate(message.sentAt)}</time>
      </div>
      {sanitized.blockedImages && (
        <div className="image-notice">
          Remote images are blocked for your privacy.{" "}
          <button type="button" onClick={() => setImages(true)}>
            Load images
          </button>
        </div>
      )}
      <iframe
        title={`Message from ${message.from.name ?? message.from.email}`}
        sandbox="allow-popups allow-popups-to-escape-sandbox"
        referrerPolicy="no-referrer"
        srcDoc={sanitized.srcDoc}
        className="message-frame"
      />
      {attachmentError && (
        <p role="alert">Could not download the attachment. Please try again.</p>
      )}
      {message.attachments.length > 0 && (
        <div className="attachment-list">
          {message.attachments.map((attachment) => (
            <Button
              variant="ghost"
              key={attachment.id}
              onClick={() => {
                void download(attachment.blobId, attachment.name).then(
                  (success) => setAttachmentError(!success),
                );
              }}
            >
              ⇩ {attachment.name} ({Math.ceil(attachment.size / 1024)} KB)
            </Button>
          ))}
        </div>
      )}
    </article>
  );
}
function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function Composer({
  draft,
  onClose,
  onNotice,
  onRefresh,
}: {
  draft: Draft;
  onClose: () => void;
  onNotice: (value: string) => void;
  onRefresh: () => void;
}) {
  const [content, setContent] = useState(() => contentOf(draft));
  const [to, setTo] = useState(() =>
    draft.to.map((address) => address.email).join(", "),
  );
  const [cc, setCc] = useState(() =>
    draft.cc.map((address) => address.email).join(", "),
  );
  const [bcc, setBcc] = useState(() =>
    draft.bcc.map((address) => address.email).join(", "),
  );
  const [expanded, setExpanded] = useState(false);
  const [minimized, setMinimized] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const saveQueue = useRef<Promise<void>>(Promise.resolve());
  useEffect(() => {
    if (busy) return undefined;
    const timer = window.setTimeout(() => {
      const value: DraftContent = {
        ...content,
        to: splitAddresses(to),
        cc: splitAddresses(cc),
        bcc: splitAddresses(bcc),
        htmlBody: `<p>${escapeHtml(content.textBody).replaceAll("\n", "<br>")}</p>`,
      };
      saveQueue.current = saveQueue.current
        .then(async () => {
          await mailClient.updateDraft({
            accountId,
            draftId: draft.id,
            draft: value,
          });
          return undefined;
        })
        .catch(() => {
          setError("Could not save this draft. Try again.");
          return undefined;
        });
    }, 1000);
    return () => window.clearTimeout(timer);
  }, [content, to, cc, bcc, draft.id, busy]);
  function build(): DraftContent {
    return {
      ...content,
      to: splitAddresses(to),
      cc: splitAddresses(cc),
      bcc: splitAddresses(bcc),
      htmlBody: `<p>${escapeHtml(content.textBody).replaceAll("\n", "<br>")}</p>`,
    };
  }
  async function save() {
    await saveQueue.current;
    await mailClient.updateDraft({
      accountId,
      draftId: draft.id,
      draft: build(),
    });
    onRefresh();
  }
  async function close() {
    setBusy(true);
    try {
      await save();
      onClose();
    } catch {
      setError("Could not save this draft. Try again.");
      setBusy(false);
    }
  }
  async function send() {
    setBusy(true);
    setError("");
    try {
      const value = build();
      if (!value.to.length) {
        setError("Add at least one recipient.");
        return;
      }
      await saveQueue.current;
      await mailClient.updateDraft({
        accountId,
        draftId: draft.id,
        draft: value,
      });
      await mailClient.send({ accountId, draftId: draft.id });
      onNotice("Message sent.");
      onClose();
    } catch {
      setError(
        "Could not send this message. Check the addresses and try again.",
      );
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    setBusy(true);
    try {
      await saveQueue.current;
      await mailClient.deleteDraft({ accountId, draftId: draft.id });
      onNotice("Draft discarded.");
      onClose();
    } catch {
      setError("Could not discard this draft.");
      setBusy(false);
    }
  }
  async function upload(file: File) {
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = "";
      for (const byte of bytes) binary += String.fromCharCode(byte);
      const attachment = await mailClient.upload({
        accountId,
        name: file.name,
        type: file.type || "application/octet-stream",
        base64: btoa(binary),
      });
      setContent((value) => ({
        ...value,
        attachmentBlobIds: [...value.attachmentBlobIds, attachment.blobId],
      }));
      onNotice(`Attached ${file.name}.`);
    } catch {
      setError("Could not upload the attachment.");
    }
  }
  return (
    <section
      className={`composer ${expanded ? "expanded" : ""} ${minimized ? "minimized" : ""}`}
      aria-label="Compose message"
    >
      <div className="compose-header">
        <strong>{content.subject || "New message"}</strong>
        <div>
          <button
            type="button"
            aria-label={minimized ? "Restore draft" : "Minimize draft"}
            onClick={() => setMinimized(!minimized)}
          >
            −
          </button>
          <button
            type="button"
            aria-label={expanded ? "Restore size" : "Maximize draft"}
            onClick={() => {
              setExpanded(!expanded);
              setMinimized(false);
            }}
          >
            □
          </button>
          <button
            type="button"
            aria-label="Save and close draft"
            onClick={() => {
              void close();
            }}
          >
            ×
          </button>
        </div>
      </div>
      {!minimized && (
        <div className="compose-fields">
          <label>
            To
            <input
              value={to}
              onChange={(event) => setTo(event.target.value)}
              placeholder="Recipients, separated by commas"
            />
          </label>
          <label>
            Cc
            <input value={cc} onChange={(event) => setCc(event.target.value)} />
          </label>
          <label>
            Bcc
            <input
              value={bcc}
              onChange={(event) => setBcc(event.target.value)}
            />
          </label>
          <label>
            Subject
            <input
              value={content.subject}
              onChange={(event) =>
                setContent({ ...content, subject: event.target.value })
              }
            />
          </label>
          <label className="visually-hidden" htmlFor={`body-${draft.id}`}>
            Message body
          </label>
          <textarea
            id={`body-${draft.id}`}
            value={content.textBody}
            onChange={(event) =>
              setContent({ ...content, textBody: event.target.value })
            }
            placeholder="Write your message…"
          />
          {content.attachmentBlobIds.length > 0 && (
            <p>{content.attachmentBlobIds.length} attachment(s)</p>
          )}
          {error && (
            <p className="compose-error" role="alert">
              {error}
            </p>
          )}
          <div className="compose-footer">
            <Button
              disabled={busy}
              onClick={() => {
                void send();
              }}
            >
              Send ↗
            </Button>
            <label className="attach-button">
              ＋ Attach
              <input
                type="file"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void upload(file);
                }}
              />
            </label>
            <Button
              variant="ghost"
              size="small"
              onClick={() => {
                void remove();
              }}
              aria-label="Discard draft"
            >
              ♲
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
