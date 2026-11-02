import { ORPCError } from "@orpc/client";
import * as React from "react";
import * as Menu from "@radix-ui/react-dropdown-menu";
import type { DriveCommand } from "@opensuite/contracts";
import {
  keepPreviousData,
  queryOptions,
  useQuery,
  useQueryClient,
  type QueryKey,
} from "@tanstack/react-query";
import {
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type FormEvent,
} from "react";
import { billingQuery } from "../billing/client.ts";
import { bytes } from "../billing/model.ts";
import { activeLayout, hubHref } from "../origins.ts";
import { AppShell, SidebarItem } from "../shell/app-shell.tsx";
import { Button } from "../ui/button.tsx";
import { Dialog, DialogContent } from "../ui/dialog.tsx";
import { Icon, type IconName } from "../ui/icons.tsx";
import { TextField } from "../ui/text-field.tsx";
import { useToast } from "../ui/toast.tsx";
import { command, driveTransport, entries, uploadFile } from "./client.ts";
import { firstReachable, neighbour, useFocusAfter } from "./focus.ts";
import { ShareDialog } from "./share-dialog.tsx";
import { Viewer } from "./viewer.tsx";
import {
  checkMove,
  decodeItems,
  dragKind,
  DRIVE_ITEMS_TYPE,
  encodeItems,
  executePlan,
  moveRefusal,
  planDrop,
  planFromFiles,
  type DraggedItem,
  type DropSource,
  type UploadPlan,
} from "./dnd.ts";
import {
  canPreview,
  formatBytes,
  sortEntries,
  validName,
  type DriveEntry,
} from "./model.ts";
// Vite injects the stylesheet; there is nothing to bind.
// oxlint-disable-next-line import/no-unassigned-import
import "./drive.css";

type Place = "drive" | "shared" | "trash";
type Scope = "drive" | "shared" | "trash";
type Crumb = { id: string | null; name: string };
type Destination = Crumb & { path: (string | null)[] };
type Modal = "folder" | "rename" | "move" | "share" | "delete" | null;
/** A folder (or Trash) that accepts drops. `path` lists folder ids from the root to the target. */
type DropTarget = {
  key: string;
  id: string | null;
  name: string;
  path: (string | null)[];
  files: boolean;
  items: boolean;
  trash?: boolean;
};
type DropHandlers = {
  onDragOver: (event: ReactDragEvent<HTMLElement>) => void;
  onDragLeave: (event: ReactDragEvent<HTMLElement>) => void;
  onDrop: (event: ReactDragEvent<HTMLElement>) => void;
};
type TreeDnd = {
  targetProps: (target: DropTarget) => DropHandlers;
  highlight: (key: string) => string;
  prefetch: (id: string) => void;
};
type UploadJob = {
  plan: UploadPlan;
  parentId: string | null;
  label?: string;
  /** In My drive the user owns every existing file and can replace it. */
  owned?: boolean;
};

const root: Crumb = { id: null, name: "My drive" };
const sharedRoot: Crumb = { id: null, name: "Shared with me" };
const trashRoot: Crumb = { id: null, name: "Trash" };
const failure = "Could not complete this action. Check access and try again.";

function listQuery(scope: Scope, parentId: string | null) {
  return queryOptions({
    queryKey: ["drive", "list", scope, parentId],
    queryFn: () =>
      scope === "shared" && parentId === null
        ? entries({ action: "shared" })
        : entries({ action: "list", parentId, trash: scope === "trash" }),
    staleTime: 30_000,
  });
}
const listKey = (scope: Scope, parentId: string | null): QueryKey =>
  listQuery(scope, parentId).queryKey;
function scopeOf(place: Place, parentId: string | null): Scope {
  if (place === "trash") return "trash";
  return place === "shared" && parentId === null ? "shared" : "drive";
}
const folders = (list: DriveEntry[]) =>
  sortEntries(list).filter(
    (entry) => entry.kind === "folder" && entry.state === "ready",
  );
function fileIcon(entry: DriveEntry): { icon: IconName; tone: string } {
  if (entry.kind === "folder") return { icon: "drive", tone: "folder" };
  if (entry.contentType?.startsWith("image/"))
    return { icon: "sparkle", tone: "image" };
  if (entry.contentType === "application/pdf")
    return { icon: "draft", tone: "pdf" };
  return { icon: "draft", tone: "file" };
}
function plural(count: number, noun: string) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}
function sources(transfer: DataTransfer): DropSource[] {
  const items = Array.from(transfer.items).filter(
    (item) => item.kind === "file",
  );
  // Entries must be read during the drop event; the list is emptied afterwards.
  return items.length > 0
    ? items.map((item) => ({
        entry: item.webkitGetAsEntry(),
        file: item.getAsFile(),
      }))
    : Array.from(transfer.files).map((file) => ({ entry: null, file }));
}
function run<T>(values: readonly T[], action: (value: T) => Promise<unknown>) {
  return values.reduce<Promise<{ done: T[]; failed: T[] }>>(
    async (previous, value) => {
      const result = await previous;
      try {
        await action(value);
        result.done.push(value);
      } catch {
        result.failed.push(value);
      }
      return result;
    },
    Promise.resolve({ done: [], failed: [] }),
  );
}

function Action({
  icon,
  label,
  ...props
}: React.ComponentProps<"button"> & { icon: IconName; label: string }) {
  return (
    <Button variant="secondary" size="small" title={label} {...props}>
      <Icon name={icon} size={16} />
      <span className="drive-action-label">{label}</span>
    </Button>
  );
}

function GridIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width={18}
      height={18}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      aria-hidden="true"
      focusable="false"
    >
      <path d="M4 4h6.5v6.5H4zM13.5 4H20v6.5h-6.5zM4 13.5h6.5V20H4zM13.5 13.5H20V20h-6.5z" />
    </svg>
  );
}

function FolderTree({
  parentId,
  depth,
  chain,
  selected,
  onOpen,
  excluded,
  dnd,
}: {
  parentId: string | null;
  depth: number;
  chain: Crumb[];
  selected: string | null;
  onOpen: (entry: DriveEntry, chain: Crumb[]) => void;
  excluded?: ReadonlySet<string> | undefined;
  dnd?: TreeDnd | undefined;
}) {
  const [expanded, setExpanded] = useState<string[]>([]);
  const query = useQuery({ ...listQuery("drive", parentId), select: folders });
  if (query.isError)
    return <p className="drive-tree-error">Folders unavailable</p>;
  return (
    <ul className="drive-tree">
      {(query.data ?? [])
        .filter((entry) => !excluded?.has(entry.id))
        .map((entry) => {
          const open = expanded.includes(entry.id);
          const nodeChain = [...chain, { id: entry.id, name: entry.name }];
          const key = `tree:${entry.id}`;
          return (
            <li key={entry.id}>
              <div
                className={`drive-tree-row${selected === entry.id ? " active" : ""}${dnd?.highlight(key) ?? ""}`}
                style={{ paddingLeft: `${depth * 14}px` }}
                {...dnd?.targetProps({
                  key,
                  id: entry.id,
                  name: entry.name,
                  path: [null, ...nodeChain.map((crumb) => crumb.id)],
                  files: true,
                  items: true,
                })}
              >
                <button
                  type="button"
                  className="drive-tree-toggle"
                  aria-label={`${open ? "Collapse" : "Expand"} ${entry.name}`}
                  aria-expanded={open}
                  onClick={() =>
                    setExpanded((current) =>
                      open
                        ? current.filter((id) => id !== entry.id)
                        : [...current, entry.id],
                    )
                  }
                >
                  <Icon
                    name={open ? "chevronDown" : "chevronRight"}
                    size={14}
                  />
                </button>
                <button
                  type="button"
                  className="drive-tree-name"
                  data-nav
                  aria-current={selected === entry.id ? "location" : undefined}
                  onClick={() => onOpen(entry, nodeChain)}
                  onMouseEnter={() => dnd?.prefetch(entry.id)}
                  onFocus={() => dnd?.prefetch(entry.id)}
                >
                  <Icon name="drive" size={16} />
                  <span>{entry.name}</span>
                </button>
              </div>
              {open && depth < 20 && (
                <FolderTree
                  parentId={entry.id}
                  depth={depth + 1}
                  chain={nodeChain}
                  selected={selected}
                  onOpen={onOpen}
                  excluded={excluded}
                  dnd={dnd}
                />
              )}
            </li>
          );
        })}
    </ul>
  );
}

type ConflictChoice = "replace" | "keep" | "skip";
type Transfer = {
  name: string;
  phase: string;
  progress: number;
  index: number;
  total: number;
};
export function DrivePage() {
  const queryClient = useQueryClient();
  const billingOverview = useQuery(billingQuery);
  const storage = billingOverview.data?.storage;
  const settingsHref = hubHref(activeLayout(), "/settings/billing");
  const [quotaError, setQuotaError] = useState(false);
  const [place, setPlace] = useState<Place>("drive");
  const [path, setPath] = useState<Crumb[]>([root]);
  const [view, setView] = useState<"list" | "grid">("list");
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [modal, setModal] = useState<Modal>(null);
  const [name, setName] = useState("");
  const [destination, setDestination] = useState<Destination>({
    ...root,
    path: [null],
  });
  // Problems with what a dialog asks for show in the dialog itself.
  const [dialogError, setDialogError] = useState("");
  const [busy, setBusy] = useState(false);
  const [transfer, setTransfer] = useState<Transfer | null>(null);
  const [viewing, setViewing] = useState<string | null>(null);
  const [newMenu, setNewMenu] = useState<"sidebar" | "main" | null>(null);
  const [fileDrag, setFileDrag] = useState<DOMRect | null>(null);
  const [hover, setHover] = useState<{
    key: string;
    valid: boolean;
    name: string;
  } | null>(null);
  const [draggingIds, setDraggingIds] = useState<string[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const controller = useRef<AbortController | null>(null);
  const queue = useRef<UploadJob[]>([]);
  const anchor = useRef<string | null>(null);
  const dragging = useRef<DraggedItem[] | null>(null);
  const dragDepth = useRef(0);
  const menuAction = useRef(false);
  const itemsRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const opener = useRef<Element | null>(null);
  const { notify } = useToast();
  const focusAfter = useFocusAfter();
  const parentId = path.at(-1)?.id ?? null;
  const here = path.at(-1) ?? root;
  const scope = scopeOf(place, parentId);
  const canCreate = place !== "trash" && !(place === "shared" && !parentId);
  const canMoveItems = place === "drive";

  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => {
    const timer = setTimeout(() => setSearch(searchInput), 250);
    return () => clearTimeout(timer);
  }, [searchInput]);

  const list = useQuery({
    ...listQuery(scope, parentId),
    placeholderData: keepPreviousData,
  });
  const all = list.data ?? [];
  const visible = sortEntries(all).filter((entry) =>
    entry.name.toLocaleLowerCase().includes(search.toLocaleLowerCase()),
  );
  const selectedEntries = all.filter((entry) => selectedIds.includes(entry.id));
  // The viewer steps through the files of the current listing.
  const viewerFiles = visible.filter(
    (entry) => entry.kind === "file" && entry.state === "ready",
  );
  const viewerIndex = viewerFiles.findIndex((entry) => entry.id === viewing);
  const selected =
    selectedEntries.length === 1 ? (selectedEntries[0] ?? null) : null;
  const stale = list.isPlaceholderData;

  function announce(message: string, undo?: () => void) {
    notify(
      undo
        ? { message, action: { label: "Undo", onAction: undo } }
        : { message },
    );
  }
  const itemButton = (id: string) =>
    itemsRef.current?.querySelector<HTMLElement>(
      `[data-entry-id="${CSS.escape(id)}"] .drive-item-main`,
    ) ?? null;
  /** Focus an item once it is listed. */
  function focusItem(id: string) {
    focusAfter(() => itemButton(id));
  }
  /** Focus the item that takes the place of `ids` in the listing, else the heading. */
  function focusPast(ids: readonly string[]) {
    const next = neighbour(
      visible.map((entry) => entry.id),
      ids,
    );
    focusAfter(() =>
      firstReachable(
        next === null ? null : itemButton(next),
        headingRef.current,
      ),
    );
  }
  function invalidate(keys: QueryKey[]) {
    return Promise.all(
      keys.map((queryKey) => queryClient.invalidateQueries({ queryKey })),
    );
  }
  const trashKey: QueryKey = ["drive", "list", "trash"];
  function prefetch(id: string, target: Scope = "drive") {
    void queryClient.prefetchQuery(listQuery(target, id));
  }
  /** Removes entries from cached listings at once; returns a rollback. */
  async function removeOptimistically(items: readonly DraggedItem[]) {
    const keys = [...new Set(items.map((item) => item.parentId))].map((id) =>
      listKey("drive", id),
    );
    await Promise.all(
      keys.map((queryKey) => queryClient.cancelQueries({ queryKey })),
    );
    const ids = new Set(items.map((item) => item.id));
    const snapshots: [QueryKey, DriveEntry[] | undefined][] = keys.map(
      (queryKey) => [
        queryKey,
        queryClient.getQueryData<DriveEntry[]>(queryKey),
      ],
    );
    for (const [queryKey, data] of snapshots)
      if (data)
        queryClient.setQueryData<DriveEntry[]>(
          queryKey,
          data.filter((entry) => !ids.has(entry.id)),
        );
    return () => {
      for (const [queryKey, data] of snapshots)
        queryClient.setQueryData(queryKey, data);
    };
  }

  function clearSelection() {
    setSelectedIds([]);
    anchor.current = null;
  }
  function navigate(next: Place) {
    setPlace(next);
    setPath([
      next === "shared" ? sharedRoot : next === "trash" ? trashRoot : root,
    ]);
    clearSelection();
    setSearchInput("");
    setSearch("");
  }
  function goTo(next: Crumb[]) {
    setPath(next);
    clearSelection();
    setSearchInput("");
    setSearch("");
  }
  function openFolder(entry: DriveEntry) {
    goTo([...path, { id: entry.id, name: entry.name }]);
  }
  function treeOpen(_entry: DriveEntry, chain: Crumb[]) {
    // In Trash, a tree folder shows the trashed items it contains.
    if (place === "shared") setPlace("drive");
    goTo([place === "trash" ? trashRoot : root, ...chain]);
  }
  function choose(
    entry: DriveEntry,
    modifiers: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean },
  ) {
    const ids = visible.map((item) => item.id);
    if (modifiers.shiftKey && anchor.current && ids.includes(anchor.current)) {
      const [from, to] = [ids.indexOf(anchor.current), ids.indexOf(entry.id)];
      const range = ids.slice(Math.min(from, to), Math.max(from, to) + 1);
      setSelectedIds((current) =>
        modifiers.ctrlKey || modifiers.metaKey
          ? [...new Set([...current, ...range])]
          : range,
      );
      return;
    }
    anchor.current = entry.id;
    if (modifiers.ctrlKey || modifiers.metaKey) toggle(entry);
    else setSelectedIds([entry.id]);
  }
  function toggle(entry: DriveEntry) {
    anchor.current = entry.id;
    setSelectedIds((current) =>
      current.includes(entry.id)
        ? current.filter((id) => id !== entry.id)
        : [...current, entry.id],
    );
  }

  /** Runs a dialog's command; a failure shows in the dialog. */
  async function perform(input: DriveCommand, keys: QueryKey[]) {
    setBusy(true);
    setDialogError("");
    try {
      const result = await command(input);
      await invalidate(keys);
      return result;
    } catch {
      setDialogError(failure);
      return null;
    } finally {
      setBusy(false);
    }
  }
  function showModal(next: Modal) {
    opener.current = document.activeElement;
    setName(next === "rename" ? (selected?.name ?? "") : "");
    setDestination({ ...root, path: [null] });
    setDialogError("");
    setModal(next);
  }
  /** A dismissed dialog gives focus back to what opened it. */
  function dismissModal() {
    setModal(null);
    setDialogError("");
    const from = opener.current;
    const item = selected?.id;
    focusAfter(() =>
      firstReachable(
        from instanceof HTMLElement ? from : null,
        item === undefined ? null : itemButton(item),
        headingRef.current,
      ),
    );
  }
  async function rename(entry: DriveEntry, value: string) {
    const key = listKey(scope, parentId);
    await queryClient.cancelQueries({ queryKey: key });
    const previous = queryClient.getQueryData<DriveEntry[]>(key);
    if (previous)
      queryClient.setQueryData<DriveEntry[]>(
        key,
        previous.map((item) =>
          item.id === entry.id ? { ...item, name: value } : item,
        ),
      );
    setModal(null);
    const ok = await perform({ action: "rename", id: entry.id, name: value }, [
      key,
    ]);
    if (!ok) {
      queryClient.setQueryData(key, previous);
      setModal("rename");
      return;
    }
    announce("Item renamed.");
    focusItem(entry.id);
  }
  async function saveName(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = name.trim();
    if (!validName(value)) {
      setDialogError(
        "Enter a name of up to 255 characters without slashes or control characters.",
      );
      return;
    }
    if (modal !== "folder") {
      if (selected) await rename(selected, value);
      return;
    }
    const created = await perform({ action: "folder", name: value, parentId }, [
      listKey("drive", parentId),
    ]);
    if (!created || !("kind" in created)) return;
    setModal(null);
    clearSelection();
    announce("Folder created.");
    focusItem(created.id);
  }

  async function moveItems(items: readonly DraggedItem[], target: Crumb) {
    setBusy(true);
    focusPast(items.map((item) => item.id));
    clearSelection();
    const known = new Map(all.map((entry) => [entry.id, entry]));
    const rollback = await removeOptimistically(items);
    const targetKey = listKey("drive", target.id);
    const cached = queryClient.getQueryData<DriveEntry[]>(targetKey);
    const arriving = items.flatMap((item) => {
      const entry = known.get(item.id);
      return entry ? [{ ...entry, parentId: target.id }] : [];
    });
    if (cached)
      queryClient.setQueryData<DriveEntry[]>(targetKey, [
        ...cached.filter(
          (entry) => !arriving.some((item) => item.id === entry.id),
        ),
        ...arriving,
      ]);
    const result = await run(items, (item) =>
      command({ action: "move", id: item.id, parentId: target.id }),
    );
    if (result.done.length === 0) rollback();
    await invalidate([
      ...items.map((item) => listKey("drive", item.parentId)),
      targetKey,
    ]);
    setBusy(false);
    if (result.failed.length > 0) {
      announce(
        result.done.length === 0
          ? failure
          : `Moved ${plural(result.done.length, "item")} to ${target.name}. ${plural(result.failed.length, "item")} could not be moved.`,
      );
      return;
    }
    const [first] = result.done;
    announce(
      `Moved ${result.done.length === 1 && first ? first.name : plural(result.done.length, "item")} to ${target.name}.`,
      () => void undoMove(result.done, target.id),
    );
  }
  async function undoMove(items: readonly DraggedItem[], from: string | null) {
    const [first] = items;
    if (first) focusItem(first.id);
    const rollback = await removeOptimistically(
      items.map((item) => ({ ...item, parentId: from })),
    );
    const result = await run(items, (item) =>
      command({ action: "move", id: item.id, parentId: item.parentId }),
    );
    if (result.done.length === 0) rollback();
    await invalidate([
      listKey("drive", from),
      ...items.map((item) => listKey("drive", item.parentId)),
    ]);
    announce(result.failed.length ? failure : "Move undone.");
  }
  async function trashItems(items: readonly DraggedItem[]) {
    setBusy(true);
    focusPast(items.map((item) => item.id));
    clearSelection();
    const rollback = await removeOptimistically(items);
    const result = await run(items, (item) =>
      command({ action: "trash", id: item.id }),
    );
    if (result.failed.length > 0) rollback();
    // A trashed folder takes its whole tree, so every listing may change.
    await invalidate([["drive", "list"]]);
    setBusy(false);
    const undo = () => void restoreItems(result.done, "restored");
    if (result.failed.length > 0)
      announce(
        result.done.length === 0
          ? failure
          : `Moved ${plural(result.done.length, "item")} to trash. ${plural(result.failed.length, "item")} could not be moved.`,
        result.done.length ? undo : undefined,
      );
    else
      announce(
        result.done.length === 1
          ? "Moved to trash."
          : `Moved ${plural(result.done.length, "item")} to trash.`,
        undo,
      );
  }
  /**
   * From the trash, focus goes to the next trashed item; after an undo, to
   * the first item brought back.
   */
  async function restoreItems(
    items: readonly DraggedItem[],
    focus: "past" | "restored" = "past",
  ) {
    setBusy(true);
    const [first] = items;
    if (focus === "past") focusPast(items.map((item) => item.id));
    else if (first) focusItem(first.id);
    clearSelection();
    const result = await run(items, (item) =>
      command({ action: "restore", id: item.id }),
    );
    // A folder brings back its tree; an item whose folder is gone returns to
    // the root.
    await invalidate([["drive", "list"]]);
    setBusy(false);
    announce(
      result.failed.length
        ? failure
        : result.done.length === 1
          ? "Item restored."
          : `Restored ${plural(result.done.length, "item")}.`,
    );
  }
  async function deleteItems(items: readonly DraggedItem[]) {
    setBusy(true);
    setDialogError("");
    const result = await run(items, (item) =>
      command({ action: "delete", id: item.id }),
    );
    await invalidate([trashKey]);
    setBusy(false);
    if (result.failed.length) {
      setDialogError(failure);
      return;
    }
    focusPast(items.map((item) => item.id));
    setModal(null);
    clearSelection();
    announce(
      result.done.length === 1
        ? "Item permanently deleted."
        : `${plural(result.done.length, "item")} permanently deleted.`,
    );
  }

  function queueUpload(job: UploadJob) {
    if (job.plan.files.length === 0 && job.plan.folders.length === 0) return;
    queue.current.push({ ...job, owned: place === "drive" });
    void drainUploads();
  }
  // One name conflict is asked at a time; "apply to all" answers the rest of
  // the upload. Only files the user owns can be replaced (moved to trash).
  const [conflict, setConflict] = useState<{
    name: string;
    replaceable: boolean;
    resolve: (choice: ConflictChoice, all: boolean) => void;
  } | null>(null);
  const [conflictAll, setConflictAll] = useState(false);
  const conflictTurn = useRef<Promise<unknown>>(Promise.resolve());
  const conflictChoice = useRef<ConflictChoice | null>(null);
  function askConflict(
    fileName: string,
    replaceable: boolean,
    signal: AbortSignal,
  ) {
    const turn = conflictTurn.current.then(() => {
      const remembered = conflictChoice.current;
      if (remembered)
        return remembered === "replace" && !replaceable ? "keep" : remembered;
      return new Promise<ConflictChoice>((resolve) => {
        if (signal.aborted) return resolve("skip");
        const stop = () => answer("skip", false);
        const answer = (choice: ConflictChoice, everywhere: boolean) => {
          signal.removeEventListener("abort", stop);
          if (everywhere) conflictChoice.current = choice;
          setConflict(null);
          resolve(choice);
        };
        signal.addEventListener("abort", stop, { once: true });
        setConflictAll(false);
        setConflict({ name: fileName, replaceable, resolve: answer });
      });
    });
    conflictTurn.current = turn;
    return turn;
  }
  // Parallel transfers report many times per frame; render at most once.
  const pendingTransfer = useRef<{ value: Transfer | null; frame: number }>({
    value: null,
    frame: 0,
  });
  function showTransfer(value: Transfer | null) {
    const pending = pendingTransfer.current;
    pending.value = value;
    if (value === null) {
      cancelAnimationFrame(pending.frame);
      pending.frame = 0;
      setTransfer(null);
    } else if (pending.frame === 0)
      pending.frame = requestAnimationFrame(() => {
        pending.frame = 0;
        setTransfer(pending.value);
      });
  }
  async function drainUploads() {
    if (controller.current) return;
    const abort = new AbortController();
    controller.current = abort;
    const affected = new Set<string | null>();
    const finished: UploadJob[] = [];
    const failed: string[] = [];
    let quotaExceeded = false;
    setQuotaError(false);
    let uploadedFiles = 0;
    let skippedFiles = 0;
    const unreplaced: string[] = [];
    try {
      const next = async (): Promise<void> => {
        const job = queue.current.shift();
        if (!job) return;
        affected.add(job.parentId);
        conflictChoice.current = null;
        // Existing folders are merged into and existing file names are
        // resolved with the user; folders created by this job start empty.
        const fresh = new Set<string>();
        const listings = new Map<string | null, Promise<DriveEntry[]>>();
        const existing = (folder: string | null) => {
          if (folder !== null && fresh.has(folder)) return Promise.resolve([]);
          const listing =
            listings.get(folder) ??
            entries({ action: "list", parentId: folder, trash: false }).catch(
              () => [],
            );
          listings.set(folder, listing);
          return listing;
        };
        // Names chosen by "keep both" in this job, per folder.
        const reserved = new Map<string | null, Set<string>>();
        const freeName = async (folder: string | null, wanted: string) => {
          const taken = new Set([
            ...(await existing(folder)).map((entry) => entry.name),
            ...(reserved.get(folder) ?? []),
          ]);
          const dot = wanted.lastIndexOf(".");
          const [stem, extension] =
            dot > 0 ? [wanted.slice(0, dot), wanted.slice(dot)] : [wanted, ""];
          let copy = 1;
          while (taken.has(`${stem} (${copy})${extension}`)) copy++;
          const chosen = `${stem} (${copy})${extension}`;
          reserved.set(folder, taken.add(chosen));
          return chosen;
        };
        const named = async (
          folder: string | null,
          kind: string,
          entryName: string,
        ) =>
          (await existing(folder)).find(
            (entry) =>
              entry.kind === kind &&
              entry.state === "ready" &&
              entry.name === entryName,
          );
        // Files upload in parallel; the bar shows the whole job by bytes.
        const files = new Map<
          File,
          { phase: string; fraction: number; order: number }
        >();
        const jobBytes =
          job.plan.files.reduce((sum, item) => sum + item.file.size, 0) || 1;
        let started = 0;
        const report = () => {
          let done = 0;
          let sent = 0;
          let latest: [File, { phase: string; order: number }] | undefined;
          for (const [file, state] of files) {
            sent += state.fraction * (file.size || 1);
            if (state.phase === "Done") done++;
            else if (!latest || state.order > latest[1].order)
              latest = [file, state];
          }
          const phases = new Set(
            [...files.values()].map((state) => state.phase),
          );
          showTransfer({
            name: latest?.[0].name ?? "",
            phase: phases.has("Uploading")
              ? "Uploading"
              : phases.has("Checking file")
                ? "Checking file"
                : started < job.plan.files.length
                  ? "Uploading"
                  : "Finalizing",
            progress: Math.min(1, sent / jobBytes),
            index: Math.min(done + 1, job.plan.files.length),
            total: job.plan.files.length,
          });
        };
        failed.push(...(job.plan.skipped ?? []));
        const result = await executePlan(job.plan, job.parentId, {
          signal: abort.signal,
          concurrency: 4,
          step: (step) => {
            if (step.kind === "folder")
              return showTransfer({
                name: step.name,
                index: step.index + 1,
                total: step.total,
                phase: "Creating folder",
                progress: 0,
              });
            files.set(step.file, {
              phase: "Uploading",
              fraction: 0,
              order: started++,
            });
            report();
          },
          createFolder: async (folderName, folderParent) => {
            const match = await named(folderParent, "folder", folderName);
            if (match) return match.id;
            const created = await command({
              action: "folder",
              name: folderName,
              parentId: folderParent,
            });
            if (!("kind" in created)) throw new Error("Unexpected response");
            affected.add(folderParent);
            fresh.add(created.id);
            return created.id;
          },
          upload: async (file, fileParent) => {
            affected.add(fileParent);
            const state = files.get(file);
            const twin = await named(fileParent, "file", file.name);
            const choice = twin
              ? await askConflict(file.name, job.owned === true, abort.signal)
              : "keep";
            if (choice === "skip") {
              if (state) Object.assign(state, { phase: "Done", fraction: 1 });
              report();
              return false;
            }
            const uploadName =
              twin && choice === "keep"
                ? await freeName(fileParent, file.name)
                : file.name;
            try {
              await uploadFile(
                file,
                fileParent,
                abort.signal,
                (phase, value) => {
                  // Only the transfer moves the bar; later phases keep it full.
                  if (state)
                    Object.assign(state, {
                      phase,
                      fraction: phase === "Uploading" ? value : 1,
                    });
                  report();
                },
                uploadName,
              );
              if (state) Object.assign(state, { phase: "Done", fraction: 1 });
              // The replaced file goes to the trash, where it can be restored.
              if (twin && choice === "replace")
                await command({ action: "trash", id: twin.id }).catch(() =>
                  unreplaced.push(file.name),
                );
              return true;
            } catch (error) {
              if (
                error instanceof ORPCError &&
                (error.code === "QUOTA_EXCEEDED" || error.code === "NO_PLAN")
              )
                quotaExceeded = true;
              // A failed file is settled; the bar moves past it.
              if (state) Object.assign(state, { phase: "Done", fraction: 1 });
              throw error;
            } finally {
              report();
            }
          },
        });
        uploadedFiles += result.uploaded;
        skippedFiles += result.skipped;
        failed.push(...result.failed);
        finished.push(job);
        await next();
      };
      await next();
      const files = uploadedFiles;
      const created = finished.reduce(
        (sum, job) => sum + job.plan.folders.length,
        0,
      );
      const label =
        finished.length === 1 && finished[0]?.label
          ? ` to ${finished[0].label}`
          : "";
      const uploadedText =
        files === 0 && skippedFiles > 0
          ? ""
          : created > 0
            ? `Uploaded ${plural(files, "file")} in ${plural(created, "folder")}${label}.`
            : `${files === 1 ? "File" : "Files"} uploaded${label}.`;
      const done = [
        uploadedText,
        skippedFiles > 0
          ? `${plural(skippedFiles, "existing file")} skipped.`
          : "",
        unreplaced.length > 0
          ? `${plural(unreplaced.length, "replaced file")} could not be moved to trash: ${unreplaced.slice(0, 5).join(", ")}.`
          : "",
      ]
        .filter(Boolean)
        .join(" ");
      const shown = failed.slice(0, 5).join(", ");
      setQuotaError(quotaExceeded);
      announce(
        failed.length === 0
          ? done
          : `${files > 0 ? `${done} ` : ""}${plural(failed.length, "item")} could not be uploaded: ${shown}${failed.length > 5 ? "…" : ""}`,
      );
    } catch (error) {
      queue.current = [];
      announce(
        error instanceof DOMException && error.name === "AbortError"
          ? "Upload cancelled."
          : error instanceof Error
            ? error.message
            : "Upload failed. Please try again.",
      );
    } finally {
      controller.current = null;
      showTransfer(null);
      await invalidate([...affected].map((id) => listKey("drive", id)));
      void queryClient.invalidateQueries({ queryKey: billingQuery.queryKey });
    }
  }
  function uploadFiles(files: File[], plan?: UploadPlan) {
    queueUpload({
      plan: plan ?? {
        folders: [],
        files: files.map((file) => ({ file, path: [] })),
      },
      parentId,
    });
  }
  async function uploadDrop(
    dropped: DropSource[],
    target: Crumb,
    label?: string,
  ) {
    try {
      const plan = await planDrop(dropped);
      queueUpload(
        label
          ? { plan, parentId: target.id, label }
          : { plan, parentId: target.id },
      );
    } catch {
      announce("Could not read the dropped items. Try the Upload button.");
    }
  }

  // Drag and drop is an enhancement over the buttons and the Move dialog.
  function evaluate(target: DropTarget, types: readonly string[]) {
    const kind = dragKind(types);
    if (modal || !kind) return "none";
    if (kind === "files") return target.files ? "copy" : "none";
    if (!target.items) return "none";
    const items = dragging.current;
    if (!items || target.trash) return "move";
    return checkMove(items, target.id, target.path).ok ? "move" : "none";
  }
  function targetProps(target: DropTarget): DropHandlers {
    return {
      onDragOver: (event) => {
        if (!dragKind(event.dataTransfer.types)) return;
        const effect = evaluate(target, event.dataTransfer.types);
        event.preventDefault();
        event.dataTransfer.dropEffect = effect;
        const valid = effect !== "none";
        setHover((current) =>
          current?.key === target.key && current.valid === valid
            ? current
            : { key: target.key, valid, name: target.name },
        );
      },
      onDragLeave: (event) => {
        const related = event.relatedTarget;
        if (related instanceof Node && event.currentTarget.contains(related))
          return;
        setHover((current) => (current?.key === target.key ? null : current));
      },
      onDrop: (event) => {
        const kind = dragKind(event.dataTransfer.types);
        if (!kind) return;
        event.preventDefault();
        setHover(null);
        if (evaluate(target, event.dataTransfer.types) === "none") {
          const items = dragging.current;
          const check =
            kind === "items" && items
              ? checkMove(items, target.id, target.path)
              : null;
          announce(
            check && !check.ok
              ? moveRefusal(check.reason)
              : target.trash
                ? "Files cannot be uploaded to Trash."
                : "Items cannot be dropped here.",
          );
          endDrag();
          return;
        }
        if (kind === "files") {
          void uploadDrop(sources(event.dataTransfer), target, target.name);
          return;
        }
        const items =
          dragging.current ??
          decodeItems(event.dataTransfer.getData(DRIVE_ITEMS_TYPE));
        endDrag();
        if (target.trash) {
          void trashItems(items);
          return;
        }
        const check = checkMove(items, target.id, target.path);
        if (!check.ok) announce(moveRefusal(check.reason));
        else void moveItems(check.items, target);
      },
    };
  }
  function highlight(key: string) {
    if (hover?.key !== key) return "";
    return hover.valid ? " drop-target" : " drop-refused";
  }
  function startDrag(event: ReactDragEvent<HTMLElement>, entry: DriveEntry) {
    const group = (
      selectedIds.includes(entry.id) ? selectedEntries : [entry]
    ).filter((item) => item.state === "ready");
    if (!canMoveItems || group.length === 0) {
      event.preventDefault();
      return;
    }
    if (!selectedIds.includes(entry.id)) {
      anchor.current = entry.id;
      setSelectedIds([entry.id]);
    }
    dragging.current = group;
    setDraggingIds(group.map((item) => item.id));
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData(DRIVE_ITEMS_TYPE, encodeItems(group));
    const ghost = document.createElement("div");
    ghost.className = "drive-drag-image";
    const label = document.createElement("span");
    label.textContent =
      group.length === 1 ? entry.name : plural(group.length, "item");
    const count = document.createElement("strong");
    count.textContent = String(group.length);
    ghost.append(count, label);
    document.body.append(ghost);
    event.dataTransfer.setDragImage(ghost, 20, 20);
    setTimeout(() => ghost.remove(), 0);
  }
  function endDrag() {
    dragging.current = null;
    setDraggingIds([]);
    setHover(null);
  }
  const onWindowDrag = useEffectEvent((event: DragEvent) => {
    if (event.type === "dragend") {
      endDrag();
      return;
    }
    const data = event.dataTransfer;
    if (dragKind(data?.types) !== "files" || !data) {
      if (event.type === "drop") {
        dragDepth.current = 0;
        setFileDrag(null);
        setHover(null);
      }
      return;
    }
    if (event.type === "dragenter") {
      dragDepth.current += 1;
      if (dragDepth.current === 1)
        setFileDrag(
          document.getElementById("drive-main")?.getBoundingClientRect() ??
            null,
        );
    } else if (event.type === "dragleave") {
      dragDepth.current = Math.max(0, dragDepth.current - 1);
      if (dragDepth.current === 0) {
        setFileDrag(null);
        setHover(null);
      }
    } else if (event.type === "dragover") {
      if (event.defaultPrevented) return;
      event.preventDefault();
      data.dropEffect = canCreate && !modal ? "copy" : "none";
      setHover(null);
    } else if (event.type === "drop") {
      dragDepth.current = 0;
      setFileDrag(null);
      if (event.defaultPrevented) return;
      event.preventDefault();
      setHover(null);
      if (modal) return;
      if (canCreate) void uploadDrop(sources(data), here);
      else announce(`Files cannot be uploaded to ${here.name}.`);
    }
  });
  useEffect(() => {
    const listener = (event: DragEvent) => onWindowDrag(event);
    const types: (
      "dragenter" | "dragover" | "dragleave" | "drop" | "dragend"
    )[] = ["dragenter", "dragover", "dragleave", "drop", "dragend"];
    for (const type of types) window.addEventListener(type, listener);
    return () => {
      for (const type of types) window.removeEventListener(type, listener);
    };
  }, []);

  function openEntry(entry: DriveEntry) {
    anchor.current = entry.id;
    setSelectedIds([entry.id]);
    if (entry.kind === "folder") openFolder(entry);
    else if (place !== "trash" && entry.state === "ready") setViewing(entry.id);
  }
  const pathIds = path.map((crumb) => crumb.id);
  const treeDnd: TreeDnd = { targetProps, highlight, prefetch };
  const menuAnchor = (where: "sidebar" | "main") =>
    (newMenu ?? "sidebar") === where ? (
      <Menu.Trigger asChild>
        <span className="drive-new-anchor" aria-hidden="true" />
      </Menu.Trigger>
    ) : null;
  const overlayLabel =
    hover && fileDrag
      ? hover.valid
        ? `Drop files to upload to ${hover.name}`
        : "Files cannot be uploaded here"
      : canCreate
        ? `Drop files to upload to ${here.name}`
        : `Files cannot be uploaded to ${here.name}`;

  return (
    <Menu.Root
      modal={false}
      open={newMenu !== null}
      onOpenChange={(open) => {
        if (!open) setNewMenu(null);
      }}
    >
      <AppShell
        product="drive"
        mainId="drive-main"
        mainClassName="drive-main"
        primaryAction={{
          label: "New",
          icon: "plus",
          onClick: () => {
            menuAction.current = false;
            setNewMenu(
              window.matchMedia("(max-width: 900px)").matches
                ? "main"
                : "sidebar",
            );
          },
        }}
        sidebar={
          <>
            {menuAnchor("sidebar")}
            <nav aria-label="Drive navigation" className="drive-navigation">
              <SidebarItem
                icon="drive"
                label="My drive"
                active={place === "drive"}
                className={`shell-nav-item${place === "drive" ? " active" : ""}${highlight("nav:drive")}`}
                onClick={() => navigate("drive")}
                {...targetProps({
                  key: "nav:drive",
                  id: null,
                  name: root.name,
                  path: [null],
                  files: true,
                  items: canMoveItems,
                })}
              />
              <SidebarItem
                icon="contacts"
                label="Shared with me"
                active={place === "shared"}
                onClick={() => navigate("shared")}
              />
              <SidebarItem
                icon="trash"
                label="Trash"
                active={place === "trash"}
                className={`shell-nav-item${place === "trash" ? " active" : ""}${highlight("nav:trash")}`}
                onClick={() => navigate("trash")}
                {...targetProps({
                  key: "nav:trash",
                  id: null,
                  name: "Trash",
                  path: [],
                  files: false,
                  items: canMoveItems,
                  trash: true,
                })}
              />
            </nav>
            <p className="shell-nav-heading">Folders</p>
            <div className="drive-sidebar-tree">
              <FolderTree
                parentId={null}
                depth={0}
                chain={[]}
                selected={place === "shared" ? null : parentId}
                onOpen={treeOpen}
                dnd={treeDnd}
              />
            </div>
            <div className="drive-storage">
              <p className="shell-nav-heading">Storage</p>
              {storage?.measured ? (
                <>
                  <strong>
                    {bytes(storage.usedBytes)} used
                    {storage.quotaBytes !== null
                      ? ` of ${bytes(storage.quotaBytes)}`
                      : ""}
                  </strong>
                  <small>
                    Drive {bytes(storage.driveBytes)} · Mail{" "}
                    {bytes(storage.mailBytes)}
                  </small>
                </>
              ) : (
                <strong>Usage temporarily unavailable</strong>
              )}
              <a className="drive-plan-link" href={settingsHref}>
                Plan &amp; storage
              </a>
            </div>
          </>
        }
        search={
          <div className="shell-searchbox">
            <Icon name="search" />
            <label className="visually-hidden" htmlFor="drive-search">
              Search Drive
            </label>
            <input
              id="drive-search"
              type="search"
              placeholder={`Search in ${here.name}`}
              value={searchInput}
              onChange={(event) => setSearchInput(event.target.value)}
            />
          </div>
        }
      >
        <div className="drive-page">
          {menuAnchor("main")}
          {billingOverview.data?.uploadsAllowed === false && (
            <output className="drive-quota-banner">
              {billingOverview.data.plan === "none"
                ? "Choose a plan to enable uploads and incoming mail."
                : "Storage quota reached: new uploads and incoming mail are paused; nothing is deleted."}{" "}
              <a className="drive-plan-link" href={settingsHref}>
                Plan &amp; storage
              </a>
            </output>
          )}
          {quotaError && (
            <div className="drive-quota-banner is-error" role="alert">
              Storage quota exceeded. Your upload could not be completed.{" "}
              <a className="drive-plan-link" href={settingsHref}>
                Review plan &amp; storage
              </a>
            </div>
          )}
          <div className="drive-header">
            <nav aria-label="Breadcrumb" hidden={path.length === 1}>
              <ol className="drive-breadcrumbs">
                {path.map((crumb, index) => {
                  const key = `crumb:${index}`;
                  const accepts =
                    place === "drive" || (place === "shared" && !!crumb.id);
                  return (
                    <li key={crumb.id ?? "root"}>
                      {index > 0 && <Icon name="chevronRight" size={14} />}
                      <button
                        type="button"
                        className={highlight(key).trim()}
                        aria-current={
                          index === path.length - 1 ? "page" : undefined
                        }
                        onClick={() => goTo(path.slice(0, index + 1))}
                        {...(accepts
                          ? targetProps({
                              key,
                              id: crumb.id,
                              name: crumb.name,
                              path: pathIds.slice(0, index + 1),
                              files: true,
                              items: canMoveItems,
                            })
                          : {})}
                      >
                        {crumb.name}
                      </button>
                    </li>
                  );
                })}
              </ol>
            </nav>
            <div className="drive-title-row">
              <div>
                <h1 ref={headingRef} tabIndex={-1}>
                  {here.name}
                </h1>
                <p className="drive-subtitle">
                  {place === "trash" ? (
                    "Restore items or delete them permanently."
                  ) : place === "shared" ? (
                    "Items others have shared with you."
                  ) : (
                    <>
                      <span className="drive-hint-pointer">
                        Drag files or folders here to upload, or drag items onto
                        a folder to move them.
                      </span>
                      <span className="drive-hint-touch">
                        Upload files or create folders. Select items to move or
                        share them.
                      </span>
                    </>
                  )}
                </p>
              </div>
              <div className="drive-header-actions">
                <Button
                  variant="secondary"
                  onClick={() => showModal("folder")}
                  disabled={!canCreate}
                >
                  <Icon name="plus" /> New folder
                </Button>
                <Button
                  onClick={() => fileInput.current?.click()}
                  disabled={!canCreate}
                >
                  <Icon name="upload" /> Upload files
                </Button>
                <input
                  ref={fileInput}
                  className="visually-hidden"
                  type="file"
                  multiple
                  tabIndex={-1}
                  aria-label="Choose files to upload"
                  onChange={(event) => {
                    const files = Array.from(event.target.files ?? []);
                    event.target.value = "";
                    uploadFiles(files);
                  }}
                />
                <input
                  ref={(node) => {
                    folderInput.current = node;
                    node?.setAttribute("webkitdirectory", "");
                  }}
                  className="visually-hidden"
                  type="file"
                  tabIndex={-1}
                  aria-label="Choose a folder to upload"
                  onChange={(event) => {
                    const files = Array.from(event.target.files ?? []);
                    event.target.value = "";
                    uploadFiles(files, planFromFiles(files));
                  }}
                />
              </div>
            </div>
          </div>
          {transfer && (
            <output className="drive-transfer">
              <div>
                <strong>
                  {transfer.phase}: {transfer.name}
                </strong>
                <span>
                  {transfer.total > 1 &&
                    `${transfer.index} of ${transfer.total} · `}
                  {Math.round(transfer.progress * 100)}%
                </span>
              </div>
              <progress
                max={1}
                value={transfer.progress}
                aria-label={`${transfer.phase}: ${transfer.name}`}
              />
              <Button
                variant="secondary"
                size="small"
                onClick={() => {
                  queue.current = [];
                  controller.current?.abort();
                }}
                disabled={transfer.phase === "Finalizing"}
              >
                Cancel upload
              </Button>
            </output>
          )}
          <div className="drive-listbar">
            {selectedEntries.length > 0 ? (
              <div
                className="drive-actions"
                role="toolbar"
                aria-label={`Actions for ${selected ? selected.name : plural(selectedEntries.length, "item")}`}
              >
                <button
                  type="button"
                  className="drive-clear"
                  aria-label="Clear selection"
                  onClick={clearSelection}
                >
                  <Icon name="close" size={16} />
                </button>
                <span className="drive-selected">
                  {selected
                    ? selected.name
                    : `${selectedEntries.length} selected`}
                </span>
                {place === "trash" ? (
                  <>
                    <Action
                      icon="back"
                      label="Restore"
                      disabled={busy}
                      onClick={() => {
                        void restoreItems(selectedEntries);
                      }}
                    />
                    <Action
                      icon="trash"
                      label="Delete permanently"
                      onClick={() => showModal("delete")}
                    />
                  </>
                ) : selected ? (
                  <>
                    <Action
                      icon={
                        selected.kind === "folder" ? "chevronRight" : "maximize"
                      }
                      label={selected.kind === "folder" ? "Open" : "Preview"}
                      onClick={() => openEntry(selected)}
                      disabled={
                        selected.kind !== "folder" && selected.state !== "ready"
                      }
                    />
                    <Action
                      icon="download"
                      label="Download"
                      onClick={() => {
                        void download(selected, announce);
                      }}
                      disabled={
                        selected.kind !== "file" || selected.state !== "ready"
                      }
                    />
                    <ZipAction items={[selected]} folderOnly />
                    <Action
                      icon="edit"
                      label="Rename"
                      onClick={() => showModal("rename")}
                      disabled={selected.state !== "ready"}
                    />
                    <Action
                      icon="move"
                      label="Move"
                      onClick={() => showModal("move")}
                      disabled={selected.state !== "ready"}
                    />
                    <Action
                      icon="contacts"
                      label="Share"
                      onClick={() => showModal("share")}
                      disabled={selected.state !== "ready"}
                    />
                    <Action
                      icon="trash"
                      label="Move to trash"
                      disabled={busy}
                      onClick={() => {
                        void trashItems([selected]);
                      }}
                    />
                  </>
                ) : (
                  <>
                    <ZipAction items={selectedEntries} />
                    <Action
                      icon="move"
                      label="Move"
                      onClick={() => showModal("move")}
                      disabled={
                        place !== "drive" ||
                        selectedEntries.some((entry) => entry.state !== "ready")
                      }
                    />
                    <Action
                      icon="trash"
                      label="Move to trash"
                      disabled={busy}
                      onClick={() => {
                        void trashItems(selectedEntries);
                      }}
                    />
                  </>
                )}
              </div>
            ) : (
              <p className="drive-count">
                {list.isSuccess ? plural(visible.length, "item") : ""}
              </p>
            )}
            <fieldset className="drive-view-toggle">
              <legend className="visually-hidden">View</legend>
              <button
                type="button"
                aria-label="List view"
                aria-pressed={view === "list"}
                onClick={() => setView("list")}
              >
                <Icon name="text" />
              </button>
              <button
                type="button"
                aria-label="Grid view"
                aria-pressed={view === "grid"}
                onClick={() => setView("grid")}
              >
                <GridIcon />
              </button>
            </fieldset>
          </div>
          <section
            className={`drive-panel${stale ? " is-stale" : ""}`}
            aria-label="Files"
            aria-busy={stale || list.isFetching}
          >
            {list.isPending ? (
              <output className="drive-empty">Loading files…</output>
            ) : list.isError ? (
              <div className="drive-empty">
                <strong>Drive is unavailable</strong>
                <p>
                  Could not load your files. Check your connection and try
                  again.
                </p>
                <Button
                  variant="secondary"
                  onClick={() => {
                    void list.refetch();
                  }}
                >
                  Retry
                </Button>
              </div>
            ) : visible.length === 0 ? (
              <div className="drive-empty">
                <span className="drive-empty-icon" aria-hidden="true">
                  <Icon
                    name={place === "trash" ? "trash" : "upload"}
                    size={28}
                  />
                </span>
                <strong>
                  {search
                    ? "No matching items"
                    : place === "trash"
                      ? "Trash is empty"
                      : place === "shared" && parentId === null
                        ? "Nothing shared with you yet"
                        : "This folder is empty"}
                </strong>
                <p>
                  {search
                    ? "Try a different search."
                    : place === "trash"
                      ? "Items you move to trash will appear here."
                      : canCreate
                        ? "Drop files or folders here, or use Upload files."
                        : "Files and folders will appear here."}
                </p>
              </div>
            ) : (
              <>
                {view === "list" && (
                  <div className="drive-list-heading" aria-hidden="true">
                    <span>Name</span>
                    <span>Created</span>
                    <span>Size</span>
                  </div>
                )}
                <div
                  ref={itemsRef}
                  className={
                    view === "grid" ? "drive-items grid" : "drive-items"
                  }
                >
                  {visible.map((entry) => {
                    const isSelected = selectedIds.includes(entry.id);
                    const key = `item:${entry.id}`;
                    const folder =
                      entry.kind === "folder" &&
                      entry.state === "ready" &&
                      place !== "trash";
                    const { icon, tone } = fileIcon(entry);
                    return (
                      <div
                        key={entry.id}
                        data-entry-id={entry.id}
                        className={`drive-item${isSelected ? " selected" : ""}${draggingIds.includes(entry.id) ? " dragging" : ""}${highlight(key)}`}
                        draggable={canMoveItems && entry.state === "ready"}
                        onDragStart={(event) => startDrag(event, entry)}
                        onDragEnd={endDrag}
                        {...(folder
                          ? targetProps({
                              key,
                              id: entry.id,
                              name: entry.name,
                              path: [...pathIds, entry.id],
                              files: true,
                              items: canMoveItems,
                            })
                          : {})}
                      >
                        <input
                          type="checkbox"
                          className="drive-check"
                          checked={isSelected}
                          aria-label={`Select ${entry.name}`}
                          onChange={() => toggle(entry)}
                        />
                        <button
                          type="button"
                          className="drive-item-main"
                          onClick={(event) => choose(entry, event)}
                          onDoubleClick={() => openEntry(entry)}
                          onMouseEnter={
                            folder ? () => prefetch(entry.id, scope) : undefined
                          }
                          onFocus={
                            folder ? () => prefetch(entry.id, scope) : undefined
                          }
                          onKeyDown={(event) => {
                            if (event.key === "Enter") {
                              event.preventDefault();
                              openEntry(entry);
                            } else if (event.key === "Escape") clearSelection();
                          }}
                          aria-pressed={isSelected}
                          aria-label={`${entry.name}, ${entry.kind}${entry.state !== "ready" ? `, ${entry.state}` : ""}`}
                        >
                          {view === "grid" &&
                          place !== "trash" &&
                          canPreview(entry) &&
                          entry.contentType !== "application/pdf" ? (
                            <img
                              className="drive-thumbnail"
                              src={driveTransport.preview(entry.id)}
                              alt=""
                              loading="lazy"
                              decoding="async"
                              draggable={false}
                            />
                          ) : (
                            <span
                              className={`drive-file-icon ${tone}`}
                              aria-hidden="true"
                            >
                              <Icon
                                name={icon}
                                size={view === "grid" ? 28 : 20}
                                filled={entry.kind === "folder"}
                              />
                            </span>
                          )}
                          <span className="drive-file-name">
                            <strong>{entry.name}</strong>
                            <small>
                              {entry.state !== "ready"
                                ? entry.state
                                : entry.kind === "folder"
                                  ? "Folder"
                                  : (entry.contentType ?? "File")}
                            </small>
                          </span>
                          <span className="drive-item-date">
                            {new Date(entry.createdAt).toLocaleDateString()}
                          </span>
                          <span className="drive-item-size">
                            {entry.kind === "folder"
                              ? "—"
                              : formatBytes(entry.size)}
                          </span>
                        </button>
                      </div>
                    );
                  })}
                </div>
              </>
            )}
          </section>
        </div>
        {fileDrag && !modal && (
          <div
            className={`drive-drop-overlay${canCreate || hover?.valid ? "" : " refused"}`}
            style={{
              top: fileDrag.top,
              left: fileDrag.left,
              width: fileDrag.width,
              height: fileDrag.height,
            }}
            aria-hidden="true"
          >
            <div className="drive-drop-card">
              <Icon name="upload" size={28} />
              <strong>{overlayLabel}</strong>
              <span>Folders keep their structure.</span>
            </div>
          </div>
        )}
      </AppShell>
      <Menu.Portal>
        <Menu.Content
          className="menu-content drive-new-menu"
          side="bottom"
          align="start"
          sideOffset={newMenu === "sidebar" ? -6 : 4}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (menuAction.current) return;
            const button = window.matchMedia("(max-width: 900px)").matches
              ? document.getElementById("drive-main")
              : document.querySelector<HTMLElement>(".shell-primary");
            button?.focus();
          }}
        >
          <Menu.Item
            className="menu-item"
            disabled={!canCreate}
            onSelect={() => {
              menuAction.current = true;
              showModal("folder");
            }}
          >
            <Icon name="drive" /> New folder
          </Menu.Item>
          <Menu.Separator className="menu-separator" />
          <Menu.Item
            className="menu-item"
            disabled={!canCreate}
            onSelect={() => fileInput.current?.click()}
          >
            <Icon name="upload" /> Upload files
          </Menu.Item>
          <Menu.Item
            className="menu-item"
            disabled={!canCreate}
            onSelect={() => folderInput.current?.click()}
          >
            <Icon name="upload" /> Upload folder
          </Menu.Item>
        </Menu.Content>
      </Menu.Portal>
      <Dialog
        open={conflict !== null}
        onOpenChange={(open) => {
          if (!open) conflict?.resolve("skip", conflictAll);
        }}
      >
        {conflict && (
          <DialogContent
            title="File already exists"
            description={
              conflict.replaceable
                ? `“${conflict.name}” already exists here. Replace it (the current file moves to the trash), keep both, or skip it.`
                : `“${conflict.name}” already exists here. Keep both or skip it.`
            }
          >
            <label className="drive-conflict-all">
              <input
                type="checkbox"
                checked={conflictAll}
                onChange={(event) => setConflictAll(event.target.checked)}
              />
              Do this for every conflict in this upload
            </label>
            <div className="dialog-actions">
              <Button
                variant="secondary"
                onClick={() => conflict.resolve("skip", conflictAll)}
              >
                Skip
              </Button>
              <Button
                variant={conflict.replaceable ? "secondary" : "primary"}
                onClick={() => conflict.resolve("keep", conflictAll)}
              >
                Keep both
              </Button>
              {conflict.replaceable && (
                <Button
                  onClick={() => conflict.resolve("replace", conflictAll)}
                >
                  Replace
                </Button>
              )}
            </div>
          </DialogContent>
        )}
      </Dialog>
      <Dialog
        open={modal !== null}
        onOpenChange={(open) => {
          if (!open && !busy) dismissModal();
        }}
      >
        {modal === "folder" || modal === "rename" ? (
          <DialogContent
            title={modal === "folder" ? "New folder" : "Rename item"}
            description={
              modal === "folder"
                ? "Create a folder in this location."
                : "Choose a new name for this item."
            }
          >
            <form
              onSubmit={(event) => {
                void saveName(event);
              }}
            >
              <TextField
                label="Name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                maxLength={255}
              />
              {dialogError && (
                <p className="field-error" role="alert">
                  {dialogError}
                </p>
              )}
              <div className="dialog-actions">
                <Button type="submit" disabled={busy}>
                  {modal === "folder" ? "Create folder" : "Save name"}
                </Button>
              </div>
            </form>
          </DialogContent>
        ) : null}
        {modal === "move" && selectedEntries.length > 0 && (
          <DialogContent
            title={
              selected
                ? "Move item"
                : `Move ${plural(selectedEntries.length, "item")}`
            }
            description="Choose a destination. The destination must belong to the same owner."
          >
            <div className="drive-move-tree">
              <button
                type="button"
                className={destination.id === null ? "active" : ""}
                onClick={() => setDestination({ ...root, path: [null] })}
              >
                <Icon name="drive" size={16} /> My drive
              </button>
              <FolderTree
                parentId={null}
                depth={0}
                chain={[]}
                selected={destination.id}
                onOpen={(entry, chain) =>
                  setDestination({
                    id: entry.id,
                    name: entry.name,
                    path: [null, ...chain.map((crumb) => crumb.id)],
                  })
                }
                excluded={new Set(selectedEntries.map((entry) => entry.id))}
              />
            </div>
            <p>
              Destination: <strong>{destination.name}</strong>
            </p>
            {dialogError && (
              <p className="field-error" role="alert">
                {dialogError}
              </p>
            )}
            <div className="dialog-actions">
              <Button
                disabled={busy}
                onClick={() => {
                  const check = checkMove(
                    selectedEntries,
                    destination.id,
                    destination.path,
                  );
                  if (!check.ok) {
                    setDialogError(moveRefusal(check.reason));
                    return;
                  }
                  setModal(null);
                  void moveItems(check.items, destination);
                }}
              >
                Move here
              </Button>
            </div>
          </DialogContent>
        )}
        {modal === "delete" && selectedEntries.length > 0 && (
          <DialogContent
            title="Delete permanently?"
            description={`This permanently deletes ${selected ? selected.name : plural(selectedEntries.length, "item")}${selectedEntries.some((entry) => entry.kind === "folder") ? " and everything inside" : ""}. This cannot be undone.`}
          >
            {dialogError && (
              <p className="field-error" role="alert">
                {dialogError}
              </p>
            )}
            <div className="dialog-actions">
              <Button variant="secondary" onClick={dismissModal}>
                Cancel
              </Button>
              <Button
                disabled={busy}
                onClick={() => {
                  void deleteItems(selectedEntries);
                }}
              >
                Delete permanently
              </Button>
            </div>
          </DialogContent>
        )}
        {modal === "share" && selected && (
          <ShareDialog entry={selected} focusAfter={focusAfter} />
        )}
      </Dialog>
      {viewerIndex >= 0 && (
        <Viewer
          files={viewerFiles}
          index={viewerIndex}
          onIndex={(next) => {
            const target = viewerFiles[next];
            if (!target) return;
            setViewing(target.id);
            setSelectedIds([target.id]);
            anchor.current = target.id;
          }}
          onClose={() => setViewing(null)}
          onDownload={(target) => {
            void download(target, announce);
          }}
        />
      )}
    </Menu.Root>
  );
}

import { ZipAction, download } from "./zip-action.tsx";
