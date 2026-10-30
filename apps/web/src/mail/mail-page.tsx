import * as React from "react";
import type {
  DraftContent,
  MailAction,
  MailSearch,
  Message,
  ThreadSummary,
} from "@opensuite/contracts";
import {
  keepPreviousData,
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { aliasesClient } from "../aliases/client.ts";
import { canSendFrom, recipientAddresses } from "../aliases/model.ts";
import { AppShell, SidebarItem } from "../shell/app-shell.tsx";
import { Button } from "../ui/button.tsx";
import { Dialog, DialogContent } from "../ui/dialog.tsx";
import { Icon, type IconName } from "../ui/icons.tsx";
import { accountId, mailClient } from "./client.ts";
import { Composer, type ComposerState } from "./composer.tsx";
import { emptyDraft, replyDraft } from "./model.ts";
import { ReadingPane } from "./reading-pane.tsx";
import { ThreadRow } from "./thread-list.tsx";

// Alias lookups are optional in Mail. Handle failures before they reach the
// global query error handler, which otherwise redirects on a 401.
const listSenders = () => aliasesClient.list({}).catch(() => []);
const matchRecipients = (addresses: string[]) =>
  aliasesClient.match({ addresses }).catch(() => []);

const key = ["mail", accountId] as const;
const threadKey = (id: string) => [...key, "thread", id] as const;
const folderIcons: Record<string, IconName> = {
  inbox: "inbox",
  drafts: "draft",
  sent: "send",
  archive: "archive",
  trash: "trash",
  junk: "junk",
};
type ThreadPage = { threads: ThreadSummary[]; nextCursor: string | null };
type Undo = { threadIds: string[]; mailboxId: string };
const removes = (change: MailAction) =>
  change.type === "archive" ||
  change.type === "trash" ||
  change.type === "delete" ||
  change.type === "move";

function useDebounced<T>(value: T, delay: number) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}
const isTyping = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.isContentEditable ||
    target.tagName === "TEXTAREA" ||
    target.tagName === "SELECT" ||
    (target instanceof HTMLInputElement &&
      !["checkbox", "radio", "button"].includes(target.type)));
const noSelection: ReadonlySet<string> = new Set();

export function MailPage() {
  const queryClient = useQueryClient();
  const [selectedFolder, setFolder] = useState("");
  const [search, setSearch] = useState("");
  const query = useDebounced(search.trim(), 250);
  const [filters, setFilters] = useState<MailSearch>({});
  const [showFilters, setShowFilters] = useState(false);
  const [sort, setSort] = useState<"newest" | "oldest">("newest");
  const [cursor, setCursor] = useState<string | undefined>();
  const [selected, setSelected] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  // Ticked rows belong to one view; a new folder, search, filter, sort or
  // page starts with nothing selected.
  const [selection, setSelection] = useState<{
    view: string;
    ids: ReadonlySet<string>;
  }>({ view: "", ids: noSelection });
  const lastChecked = useRef<string | null>(null);
  const [composers, setComposers] = useState<ComposerState[]>([]);
  const [minimized, setMinimized] = useState<Set<string>>(new Set());
  const [help, setHelp] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string[] | null>(null);
  const [notice, setNotice] = useState("");
  const [undo, setUndo] = useState<Undo | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const identity = useQuery({
    queryKey: [...key, "identity"],
    queryFn: () => mailClient.identity({ accountId }),
    staleTime: Infinity,
  });
  const mailboxes = useQuery({
    queryKey: [...key, "mailboxes"],
    queryFn: () => mailClient.mailboxes({ accountId }),
    refetchInterval: 60_000,
  });
  const boxes = mailboxes.data?.mailboxes ?? [];
  const folder =
    selectedFolder || boxes.find((item) => item.role === "inbox")?.id || "";
  const current = boxes.find((item) => item.id === folder);
  const isDrafts = current?.role === "drafts";
  const draftList = useQuery({
    queryKey: [...key, "drafts"],
    queryFn: () => mailClient.drafts({ accountId }),
    enabled: isDrafts,
  });
  const searchInput: MailSearch = { ...filters, ...(query ? { query } : {}) };
  const listKey = [...key, "threads", folder, searchInput, sort, cursor];
  const threads = useQuery({
    queryKey: listKey,
    enabled: Boolean(folder) && !isDrafts,
    placeholderData: keepPreviousData,
    refetchInterval: 60_000,
    queryFn: () =>
      mailClient.threads({
        accountId,
        mailboxId: folder,
        limit: 50,
        sort,
        search: searchInput,
        ...(cursor ? { cursor } : {}),
      }),
  });
  const list = threads.data?.threads ?? [];
  const view = JSON.stringify([folder, searchInput, sort, cursor ?? ""]);
  const checked = selection.view === view ? selection.ids : noSelection;
  const setChecked = (ids: ReadonlySet<string>) => setSelection({ view, ids });
  const fetchThread = useCallback(
    (threadId: string) => mailClient.thread({ accountId, threadId }),
    [],
  );
  const detail = useQuery({
    queryKey: threadKey(selected ?? ""),
    queryFn: () => fetchThread(selected ?? ""),
    enabled: Boolean(selected && reading),
    staleTime: 60_000,
  });
  const aliasList = useQuery({
    queryKey: ["aliases", "list"],
    queryFn: listSenders,
    retry: false,
    staleTime: 30_000,
  });
  const messages = reading ? (detail.data?.messages ?? []) : [];
  const matches = useQueries({
    queries: messages.map((message) => {
      const addresses = recipientAddresses(message);
      return {
        queryKey: ["aliases", "match", addresses],
        queryFn: () => matchRecipients(addresses),
        enabled: addresses.length > 0,
        retry: false,
        staleTime: 30_000,
      };
    }),
  });
  const matchedByMessage = Object.fromEntries(
    messages.map((message, index) => [message.id, matches[index]?.data ?? []]),
  );
  const prefetch = useCallback(
    (threadId: string) => {
      void queryClient.prefetchQuery({
        queryKey: threadKey(threadId),
        queryFn: () => fetchThread(threadId),
        staleTime: 60_000,
      });
    },
    [queryClient, fetchThread],
  );

  const updateList = (threadIds: string[], change: MailAction) => {
    const ids = new Set(threadIds);
    queryClient.setQueryData<ThreadPage>(listKey, (previous) =>
      previous
        ? {
            ...previous,
            threads: previous.threads.flatMap((thread) => {
              if (!ids.has(thread.id)) return [thread];
              if (removes(change)) return [];
              if (change.type === "read")
                return [{ ...thread, unread: !change.value }];
              if (change.type === "star")
                return [{ ...thread, starred: change.value }];
              return [{ ...thread, labels: change.labels }];
            }),
          }
        : previous,
    );
  };
  const action = useMutation({
    mutationFn: async ({
      threadIds,
      change,
    }: {
      threadIds: string[];
      change: MailAction;
    }) => {
      const results = await Promise.allSettled(
        threadIds.map((threadId) =>
          mailClient.action({ accountId, threadId, action: change }),
        ),
      );
      if (results.some((result) => result.status === "rejected"))
        throw new Error("Action failed");
    },
    onMutate: async ({ threadIds, change }) => {
      await queryClient.cancelQueries({ queryKey: listKey });
      const previous = queryClient.getQueryData<ThreadPage>(listKey);
      updateList(threadIds, change);
      return { previous };
    },
    onError: (_error, variables, context) => {
      if (context?.previous)
        queryClient.setQueryData(listKey, context.previous);
      setUndo(null);
      const first = variables.threadIds[0];
      if (
        removes(variables.change) &&
        first &&
        variables.threadIds.length === 1
      ) {
        setSelected(first);
        setReading(true);
      }
      setNotice("Could not update the conversation. Please try again.");
    },
    onSettled: (_data, _error, { change }) => {
      void queryClient.invalidateQueries({ queryKey: [...key, "mailboxes"] });
      if (change.type !== "read" && change.type !== "star")
        void queryClient.invalidateQueries({ queryKey: [...key, "threads"] });
    },
  });

  function perform(threadIds: string[], change: MailAction) {
    if (!threadIds.length) return;
    if (removes(change)) {
      const label =
        threadIds.length > 1
          ? `${threadIds.length} conversations`
          : "Conversation";
      setUndo(
        change.type === "delete" ? null : { threadIds, mailboxId: folder },
      );
      setNotice(
        change.type === "archive"
          ? `${label} archived.`
          : change.type === "trash"
            ? `${label} moved to trash.`
            : change.type === "delete"
              ? `${label} deleted.`
              : `${label} moved.`,
      );
      if (selected && threadIds.includes(selected)) {
        // Keep the keyboard position on the following conversation.
        const index = list.findIndex((thread) => thread.id === selected);
        const rest = list.filter((thread) => !threadIds.includes(thread.id));
        setSelected(rest[Math.min(index, rest.length - 1)]?.id ?? null);
        setReading(false);
      }
      setChecked(new Set());
    }
    action.mutate({ threadIds, change });
  }
  function request(threadIds: string[], change: MailAction) {
    if (change.type === "delete") setConfirmDelete(threadIds);
    else perform(threadIds, change);
  }
  function openThread(id: string) {
    setSelected(id);
    setReading(true);
    const thread = list.find((item) => item.id === id);
    if (thread?.unread) perform([id], { type: "read", value: true });
  }
  function step(direction: "next" | "previous") {
    const index = list.findIndex((thread) => thread.id === selected);
    const next =
      list[
        direction === "next"
          ? Math.min(index + 1, list.length - 1)
          : Math.max(index - 1, 0)
      ];
    if (!next) return;
    if (reading) openThread(next.id);
    else {
      setSelected(next.id);
      prefetch(next.id);
    }
  }
  function compose(content: DraftContent = emptyDraft(), draftId?: string) {
    const existing = draftId
      ? composers.find((item) => item.draftId === draftId)
      : undefined;
    if (existing) {
      setMinimized((value) => {
        const next = new Set(value);
        next.delete(existing.key);
        return next;
      });
      return;
    }
    const state = {
      key: crypto.randomUUID(),
      draftId: draftId ?? null,
      content,
    };
    // Keep at most two open windows; older ones collapse to their title bar.
    setMinimized(
      (value) =>
        new Set([
          ...value,
          ...composers
            .slice(0, Math.max(0, composers.length - 1))
            .map((item) => item.key),
        ]),
    );
    setComposers((items) => [...items, state]);
  }
  function reply(message: Message, mode: "reply" | "all" | "forward") {
    const addresses = recipientAddresses(message);
    const open = (matched: Awaited<ReturnType<typeof aliasesClient.match>>) => {
      const alias = mode === "forward" ? undefined : matched.find(canSendFrom);
      const draft = replyDraft(
        message,
        mode,
        alias?.address ?? identity.data?.address.email,
      );
      compose(alias ? { ...draft, from: alias.address } : draft);
    };
    if (mode === "forward" || addresses.length === 0) {
      open([]);
      return;
    }
    const cached = queryClient.getQueryData<
      Awaited<ReturnType<typeof aliasesClient.match>>
    >(["aliases", "match", addresses]);
    if (cached) {
      open(cached);
      return;
    }
    // Matching must not prevent a reply when the alias service is unavailable.
    void Promise.race([
      queryClient
        .fetchQuery({
          queryKey: ["aliases", "match", addresses],
          queryFn: () => matchRecipients(addresses),
          retry: false,
          staleTime: 30_000,
        })
        .catch(() => []),
      new Promise<Awaited<ReturnType<typeof aliasesClient.match>>>((resolve) =>
        setTimeout(() => resolve([]), 2000),
      ),
    ]).then(open);
  }
  function selectFolder(id: string) {
    setFolder(id);
    setCursor(undefined);
    setSelected(null);
    setReading(false);
    setChecked(new Set());
  }
  function toggleCheck(id: string, value: boolean, range: boolean) {
    const next = new Set(checked);
    const anchor = lastChecked.current;
    if (range && anchor) {
      const a = list.findIndex((thread) => thread.id === anchor);
      const b = list.findIndex((thread) => thread.id === id);
      if (a >= 0 && b >= 0)
        for (const thread of list.slice(Math.min(a, b), Math.max(a, b) + 1))
          if (value) next.add(thread.id);
          else next.delete(thread.id);
    } else if (value) next.add(id);
    else next.delete(id);
    lastChecked.current = id;
    setChecked(next);
  }

  const selectedThread = list.find((thread) => thread.id === selected);
  const targets = checked.size ? [...checked] : selected ? [selected] : [];
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (
        event.defaultPrevented ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        help ||
        isTyping(event.target)
      )
        return;
      if (
        event.target instanceof HTMLElement &&
        event.target.closest(".composer, [role=dialog], [role=menu]")
      )
        return;
      const last = detail.data?.messages.at(-1);
      const handlers: Record<string, () => void> = {
        j: () => step("next"),
        k: () => step("previous"),
        Enter: () => selected && !reading && openThread(selected),
        o: () => selected && openThread(selected),
        u: () => setReading(false),
        Escape: () => {
          if (checked.size) setChecked(new Set());
          else setReading(false);
        },
        x: () =>
          selected && toggleCheck(selected, !checked.has(selected), false),
        e: () => perform(targets, { type: "archive" }),
        "#": () =>
          request(targets, {
            type: current?.role === "trash" ? "delete" : "trash",
          }),
        s: () =>
          selectedThread &&
          perform([selectedThread.id], {
            type: "star",
            value: !selectedThread.starred,
          }),
        U: () => perform(targets, { type: "read", value: false }),
        I: () => perform(targets, { type: "read", value: true }),
        r: () => last && reading && reply(last, "reply"),
        a: () => last && reading && reply(last, "all"),
        f: () => last && reading && reply(last, "forward"),
        c: () => compose(),
        "/": () => searchRef.current?.focus(),
        "?": () => setHelp(true),
      };
      if (
        event.key === "Enter" &&
        event.target instanceof HTMLElement &&
        event.target.tagName === "BUTTON"
      )
        return;
      const handler = handlers[event.key];
      if (!handler || event.repeat) return;
      event.preventDefault();
      handler();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });
  useEffect(() => {
    if (!notice) return undefined;
    // An undo offer expires with its notice.
    const timer = window.setTimeout(
      () => {
        setNotice("");
        setUndo(null);
      },
      undo ? 10_000 : 6000,
    );
    return () => window.clearTimeout(timer);
  }, [notice, undo]);
  useEffect(() => {
    document.title = current
      ? `${current.name}${current.unread ? ` (${current.unread})` : ""} · Esuno Mail`
      : "Esuno Mail";
  }, [current]);

  const filterCount = Object.values(filters).filter(
    (value) => value !== undefined && value !== "",
  ).length;
  const position = {
    index: list.findIndex((thread) => thread.id === selected),
    total: list.length,
  };
  const allChecked =
    list.length > 0 && list.every((thread) => checked.has(thread.id));
  const system = boxes.filter((item) => item.role !== "custom");
  const custom = boxes.filter((item) => item.role === "custom");
  return (
    <AppShell
      product="mail"
      mainId="mail-main"
      mainClassName="mail-main"
      primaryAction={{
        label: "New message",
        icon: "edit",
        shortcut: "C",
        onClick: () => compose(),
      }}
      sidebar={
        <nav aria-label="Mail folders">
          {mailboxes.isPending && (
            <div className="sidebar-skeleton" aria-hidden="true">
              <span />
              <span />
              <span />
            </div>
          )}
          {system.map((item) => (
            <SidebarItem
              key={item.id}
              icon={folderIcons[item.role] ?? "drive"}
              label={item.name}
              count={item.role === "drafts" ? item.total : item.unread}
              active={folder === item.id}
              onClick={() => selectFolder(item.id)}
            />
          ))}
          {custom.length > 0 && <p className="shell-nav-heading">Labels</p>}
          {custom.map((item) => (
            <SidebarItem
              key={item.id}
              icon="label"
              label={item.name}
              count={item.unread}
              active={folder === item.id}
              onClick={() => selectFolder(item.id)}
            />
          ))}
        </nav>
      }
      search={
        <div className="mail-search-wrap">
          <div className="shell-searchbox">
            <Icon name="search" />
            <label className="visually-hidden" htmlFor="mail-search">
              Search mail
            </label>
            <input
              ref={searchRef}
              id="mail-search"
              type="search"
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                setCursor(undefined);
              }}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  setSearch("");
                  event.currentTarget.blur();
                }
              }}
              placeholder="Search mail"
              autoComplete="off"
            />
            {search && (
              <button
                type="button"
                aria-label="Clear search"
                onClick={() => {
                  setSearch("");
                  searchRef.current?.focus();
                }}
              >
                <Icon name="close" size={16} />
              </button>
            )}
            <button
              type="button"
              aria-label="Search filters"
              aria-expanded={showFilters}
              aria-pressed={filterCount > 0}
              onClick={() => setShowFilters(!showFilters)}
            >
              <Icon name="filter" />
            </button>
          </div>
          {showFilters && (
            <fieldset className="search-filters">
              <legend className="visually-hidden">Search filters</legend>
              <label>
                From
                <input
                  value={filters.from ?? ""}
                  onChange={(event) =>
                    setFilters({
                      ...filters,
                      from: event.target.value || undefined,
                    })
                  }
                />
              </label>
              <label>
                To
                <input
                  value={filters.to ?? ""}
                  onChange={(event) =>
                    setFilters({
                      ...filters,
                      to: event.target.value || undefined,
                    })
                  }
                />
              </label>
              <label>
                After
                <input
                  type="date"
                  value={filters.after?.slice(0, 10) ?? ""}
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
                  value={filters.before?.slice(0, 10) ?? ""}
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
              <label className="check">
                <input
                  type="checkbox"
                  checked={filters.unread === true}
                  onChange={(event) =>
                    setFilters({
                      ...filters,
                      unread: event.target.checked ? true : undefined,
                    })
                  }
                />
                Unread only
              </label>
              <label className="check">
                <input
                  type="checkbox"
                  checked={filters.hasAttachment === true}
                  onChange={(event) =>
                    setFilters({
                      ...filters,
                      hasAttachment: event.target.checked ? true : undefined,
                    })
                  }
                />
                Has attachment
              </label>
              <div className="search-filter-actions">
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
                <Button size="small" onClick={() => setShowFilters(false)}>
                  Done
                </Button>
              </div>
            </fieldset>
          )}
        </div>
      }
      actions={
        <button
          type="button"
          className="shell-icon-button"
          aria-label="Keyboard shortcuts"
          onClick={() => setHelp(true)}
        >
          <Icon name="help" size={20} />
        </button>
      }
    >
      <div className={`mail-panes ${reading ? "show-reading" : ""}`}>
        <section className="thread-list" aria-label="Conversations">
          <div className="list-heading">
            {!isDrafts && list.length > 0 && (
              <input
                type="checkbox"
                className="list-check"
                aria-label="Select all conversations"
                checked={allChecked}
                ref={(element) => {
                  if (element)
                    element.indeterminate = checked.size > 0 && !allChecked;
                }}
                onChange={() =>
                  setChecked(
                    allChecked
                      ? new Set()
                      : new Set(list.map((thread) => thread.id)),
                  )
                }
              />
            )}
            {checked.size > 0 ? (
              <div className="bulk-actions">
                <span>{checked.size} selected</span>
                <button
                  type="button"
                  className="tool-button"
                  aria-label="Archive selected"
                  title="Archive (E)"
                  onClick={() => perform([...checked], { type: "archive" })}
                >
                  <Icon name="archive" />
                </button>
                <button
                  type="button"
                  className="tool-button"
                  aria-label="Move selected to trash"
                  title="Move to trash (#)"
                  onClick={() =>
                    request([...checked], {
                      type: current?.role === "trash" ? "delete" : "trash",
                    })
                  }
                >
                  <Icon name="trash" />
                </button>
                <button
                  type="button"
                  className="tool-button"
                  aria-label="Mark selected as read"
                  title="Mark as read (Shift+I)"
                  onClick={() =>
                    perform([...checked], { type: "read", value: true })
                  }
                >
                  <Icon name="check" />
                </button>
                <button
                  type="button"
                  className="tool-button"
                  aria-label="Mark selected as unread"
                  title="Mark as unread (Shift+U)"
                  onClick={() =>
                    perform([...checked], { type: "read", value: false })
                  }
                >
                  <Icon name="unread" />
                </button>
              </div>
            ) : (
              <div className="list-title">
                <h1>{current?.name ?? "Mail"}</h1>
                <span>
                  {isDrafts
                    ? `${draftList.data?.drafts.length ?? 0} drafts`
                    : query || filterCount
                      ? `${list.length} results`
                      : current?.unread
                        ? `${current.unread} unread`
                        : `${list.length} conversations`}
                </span>
              </div>
            )}
            {!isDrafts && (
              <div className="list-tools">
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
                    <option value="newest">Newest first</option>
                    <option value="oldest">Oldest first</option>
                  </select>
                </label>
                <button
                  type="button"
                  className="tool-button"
                  aria-label="Refresh"
                  title="Refresh"
                  onClick={() => {
                    void threads.refetch();
                    void mailboxes.refetch();
                  }}
                >
                  <Icon name="repeat" size={16} />
                </button>
              </div>
            )}
          </div>
          {threads.isFetching && threads.isPlaceholderData && (
            <div className="page-loading" aria-hidden="true" />
          )}
          {filterCount > 0 && (
            <div className="filter-chips">
              {Object.entries(filters).map(([name, value]) =>
                value === undefined || value === "" ? null : (
                  <button
                    type="button"
                    key={name}
                    onClick={() =>
                      setFilters({ ...filters, [name]: undefined })
                    }
                    aria-label={`Remove filter ${name}`}
                  >
                    {name === "hasAttachment"
                      ? "Has attachment"
                      : name === "unread"
                        ? "Unread"
                        : `${name}: ${String(value).slice(0, 10)}`}
                    <Icon name="close" size={12} />
                  </button>
                ),
              )}
            </div>
          )}
          <div className="thread-scroll">
            {isDrafts ? (
              draftList.isPending ? (
                <ListSkeleton />
              ) : draftList.data?.drafts.length ? (
                <ul className="thread-items">
                  {draftList.data.drafts.map((draft) => (
                    <li key={draft.id} className="draft-row">
                      <button
                        type="button"
                        onClick={() => {
                          const { id, ...content } = draft;
                          compose(content, id);
                        }}
                      >
                        <span className="draft-label">Draft</span>
                        <strong>{draft.subject || "(No subject)"}</strong>
                        <span>
                          {draft.to
                            .map((address) => address.email)
                            .join(", ") || "No recipients"}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="mail-empty">
                  <Icon name="draft" size={28} />
                  <strong>No drafts</strong>
                  <p>Messages you start and don't send are saved here.</p>
                </div>
              )
            ) : threads.isPending || mailboxes.isPending ? (
              <ListSkeleton />
            ) : threads.isError || mailboxes.isError ? (
              <div className="mail-empty" role="alert">
                <strong>
                  {navigator.onLine ? "Mail is unavailable" : "You’re offline"}
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
                <Icon
                  name={query || filterCount ? "search" : "inbox"}
                  size={28}
                />
                <strong>
                  {query || filterCount
                    ? "No matching conversations"
                    : "All clear"}
                </strong>
                <p>
                  {query || filterCount
                    ? "Try different words or remove a filter."
                    : `Nothing in ${current?.name ?? "this folder"}.`}
                </p>
              </div>
            ) : (
              <ul
                className={`thread-items ${threads.isPlaceholderData ? "stale" : ""}`}
              >
                {list.map((thread) => (
                  <ThreadRow
                    key={thread.id}
                    thread={thread}
                    selected={selected === thread.id}
                    checked={checked.has(thread.id)}
                    labels={custom.filter(
                      (label) =>
                        thread.labels.includes(label.id) && label.id !== folder,
                    )}
                    onOpen={() => openThread(thread.id)}
                    onCheck={(value, range) =>
                      toggleCheck(thread.id, value, range)
                    }
                    onPrefetch={() => prefetch(thread.id)}
                    onQuick={(change) =>
                      request(
                        [thread.id],
                        change.type === "trash" && current?.role === "trash"
                          ? { type: "delete" }
                          : change,
                      )
                    }
                  />
                ))}
              </ul>
            )}
            {!isDrafts && (cursor || threads.data?.nextCursor) && (
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
                  Older <Icon name="chevronRight" size={14} />
                </Button>
              </div>
            )}
          </div>
        </section>
        <section className="reading-pane" aria-label="Reading pane">
          {reading && selected ? (
            detail.isPending ? (
              <div
                className="reading-loading"
                aria-label="Loading conversation"
              >
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
              <ReadingPane
                key={selected}
                messages={detail.data.messages}
                aliasesByMessage={matchedByMessage}
                folder={current}
                mailboxes={boxes}
                labels={
                  selectedThread?.labels ?? [
                    ...new Set(
                      detail.data.messages.flatMap((message) => message.labels),
                    ),
                  ]
                }
                starred={
                  selectedThread?.starred ??
                  detail.data.messages.some((message) => message.starred)
                }
                position={position}
                onBack={() => setReading(false)}
                onAction={(change) => request([selected], change)}
                onReply={reply}
                onStep={step}
              />
            )
          ) : (
            <div className="reading-empty">
              <span className="reading-illustration" aria-hidden="true">
                <img className="product-mark" src="/mail-mark.svg" alt="" />
              </span>
              <h2>
                {checked.size
                  ? `${checked.size} conversation${checked.size > 1 ? "s" : ""} selected`
                  : "No conversation selected"}
              </h2>
              <p>
                {checked.size
                  ? "Use the actions above the list."
                  : "Choose a conversation to read it here."}
              </p>
              <p className="reading-hint">
                Press <kbd>?</kbd> for keyboard shortcuts
              </p>
            </div>
          )}
        </section>
      </div>
      {notice && (
        <output className="mail-notice">
          <span>{notice}</span>
          {undo && (
            <button
              type="button"
              disabled={action.isPending}
              onClick={() => {
                action.mutate({
                  threadIds: undo.threadIds,
                  change: { type: "move", mailboxId: undo.mailboxId },
                });
                setUndo(null);
                setNotice(
                  undo.threadIds.length > 1
                    ? "Conversations restored."
                    : "Conversation restored.",
                );
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
            <Icon name="close" size={16} />
          </button>
        </output>
      )}
      <div className="compose-dock">
        {composers.map((state) => (
          <Composer
            key={state.key}
            state={state}
            from={identity.data?.address.email}
            aliases={(aliasList.data ?? []).filter(canSendFrom)}
            minimized={minimized.has(state.key)}
            onMinimize={(value) =>
              setMinimized((previous) => {
                const next = new Set(previous);
                if (value) next.add(state.key);
                else next.delete(state.key);
                return next;
              })
            }
            onClose={() =>
              setComposers((items) =>
                items.filter((item) => item.key !== state.key),
              )
            }
            onNotice={(value) => {
              setUndo(null);
              setNotice(value);
            }}
            onDraftId={(id) =>
              setComposers((items) =>
                items.map((item) =>
                  item.key === state.key ? { ...item, draftId: id } : item,
                ),
              )
            }
            onSaved={() => {
              void queryClient.invalidateQueries({
                queryKey: [...key, "drafts"],
              });
              void queryClient.invalidateQueries({
                queryKey: [...key, "thread"],
              });
              void queryClient.invalidateQueries({
                queryKey: [...key, "threads"],
              });
              void queryClient.invalidateQueries({
                queryKey: [...key, "mailboxes"],
              });
            }}
          />
        ))}
      </div>
      <Dialog
        open={confirmDelete !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmDelete(null);
        }}
      >
        <DialogContent
          title="Delete permanently?"
          description="These conversations will be deleted forever. This cannot be undone."
        >
          <div className="dialog-actions">
            <Button variant="ghost" onClick={() => setConfirmDelete(null)}>
              Cancel
            </Button>
            <Button
              className="button-danger"
              onClick={() => {
                if (confirmDelete) perform(confirmDelete, { type: "delete" });
                setConfirmDelete(null);
              }}
            >
              Delete forever
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog open={help} onOpenChange={setHelp}>
        <DialogContent
          title="Keyboard shortcuts"
          description="Use these shortcuts when you are not typing."
        >
          <div className="shortcut-grid">
            {(
              [
                ["Next / previous conversation", "J / K"],
                ["Open conversation", "Enter or O"],
                ["Back to list", "U"],
                ["Select conversation", "X"],
                ["Archive", "E"],
                ["Move to trash", "#"],
                ["Star", "S"],
                ["Mark read / unread", "Shift+I / Shift+U"],
                ["Reply / reply all / forward", "R / A / F"],
                ["New message", "C"],
                ["Send message", "Ctrl+Enter"],
                ["Search", "/"],
                ["Show shortcuts", "?"],
              ] as const
            ).map(([label, keys]) => (
              <React.Fragment key={label}>
                <span>{label}</span>
                <kbd>{keys}</kbd>
              </React.Fragment>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </AppShell>
  );
}

function ListSkeleton() {
  return (
    <div className="skeleton-list" aria-label="Loading conversations">
      {Array.from({ length: 6 }, (_, index) => (
        <span key={index} />
      ))}
    </div>
  );
}
