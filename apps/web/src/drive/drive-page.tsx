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
import { AppShell, SidebarItem } from "../shell/app-shell.tsx";
import { Button } from "../ui/button.tsx";
import { Dialog, DialogContent } from "../ui/dialog.tsx";
import { Icon, type IconName } from "../ui/icons.tsx";
import { TextField } from "../ui/text-field.tsx";
import { command, driveTransport, entries, uploadFile } from "./client.ts";
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
type Modal =
  "folder" | "rename" | "move" | "share" | "preview" | "delete" | null;
type Notice = { text: string; undo?: { label: string; run: () => void } };
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
type UploadJob = { plan: UploadPlan; parentId: string | null; label?: string };

const root: Crumb = { id: null, name: "My drive" };
const sharedRoot: Crumb = { id: null, name: "Shared with me" };
const trashRoot: Crumb = { id: null, name: "Trash" };
const failure =
  "Could not complete this action. Check access and try again. Folders must be empty before moving to trash or deleting.";

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
function expiresAfter(days: number) {
  return new Date(Date.now() + days * 86_400_000).toISOString();
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

export function DrivePage() {
  const queryClient = useQueryClient();
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
  const [userId, setUserId] = useState("");
  const [access, setAccess] = useState<"read" | "write">("read");
  const [linkId, setLinkId] = useState("");
  const [link, setLink] = useState<{
    id: string;
    url: string;
    expiresAt: string;
  } | null>(null);
  const [days, setDays] = useState("7");
  const [notice, setNoticeState] = useState<Notice>({ text: "" });
  const [busy, setBusy] = useState(false);
  const [transfer, setTransfer] = useState<{
    name: string;
    phase: string;
    progress: number;
    index: number;
    total: number;
  } | null>(null);
  const [previewUrl, setPreviewUrl] = useState("");
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
  const parentId = path.at(-1)?.id ?? null;
  const here = path.at(-1) ?? root;
  const scope = scopeOf(place, parentId);
  const canCreate = place !== "trash" && !(place === "shared" && !parentId);
  const canMoveItems = place === "drive";

  useEffect(() => () => controller.current?.abort(), []);
  useEffect(
    () => () => {
      if (previewUrl.startsWith("blob:")) URL.revokeObjectURL(previewUrl);
    },
    [previewUrl],
  );
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
  const selected =
    selectedEntries.length === 1 ? (selectedEntries[0] ?? null) : null;
  const stale = list.isPlaceholderData;

  function setNotice(text: string, undo?: Notice["undo"]) {
    setNoticeState(undo ? { text, undo } : { text });
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

  async function perform(
    input: DriveCommand,
    success: string,
    keys: QueryKey[],
  ) {
    setBusy(true);
    setNotice("");
    try {
      await command(input);
      await invalidate(keys);
      setNotice(success);
      setModal(null);
      clearSelection();
      return true;
    } catch {
      setNotice(failure);
      return false;
    } finally {
      setBusy(false);
    }
  }
  function showModal(next: Modal) {
    setName(next === "rename" ? (selected?.name ?? "") : "");
    setDestination({ ...root, path: [null] });
    setUserId("");
    setLinkId("");
    setLink(null);
    setNotice("");
    setModal(next);
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
    const ok = await perform(
      { action: "rename", id: entry.id, name: value },
      "Item renamed.",
      [key],
    );
    if (!ok) {
      queryClient.setQueryData(key, previous);
      setModal("rename");
    }
  }
  async function saveName(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = name.trim();
    if (!validName(value)) {
      setNotice(
        "Enter a name of up to 255 characters without slashes or control characters.",
      );
      return;
    }
    if (modal === "folder")
      await perform(
        { action: "folder", name: value, parentId },
        "Folder created.",
        [listKey("drive", parentId)],
      );
    else if (selected) await rename(selected, value);
  }

  async function moveItems(items: readonly DraggedItem[], target: Crumb) {
    setBusy(true);
    setNotice("");
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
      setNotice(
        result.done.length === 0
          ? failure
          : `Moved ${plural(result.done.length, "item")} to ${target.name}. ${plural(result.failed.length, "item")} could not be moved.`,
      );
      return;
    }
    const [first] = result.done;
    setNotice(
      `Moved ${result.done.length === 1 && first ? first.name : plural(result.done.length, "item")} to ${target.name}.`,
      { label: "Undo", run: () => void undoMove(result.done, target.id) },
    );
  }
  async function undoMove(items: readonly DraggedItem[], from: string | null) {
    setNotice("");
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
    setNotice(result.failed.length ? failure : "Move undone.");
  }
  async function trashItems(items: readonly DraggedItem[]) {
    setBusy(true);
    setNotice("");
    clearSelection();
    const rollback = await removeOptimistically(items);
    const result = await run(items, (item) =>
      command({ action: "trash", id: item.id }),
    );
    if (result.failed.length > 0) rollback();
    await invalidate([
      ...items.map((item) => listKey("drive", item.parentId)),
      trashKey,
    ]);
    setBusy(false);
    const undo = {
      label: "Undo",
      run: () => void restoreItems(result.done),
    };
    if (result.failed.length > 0)
      setNotice(
        result.done.length === 0
          ? failure
          : `Moved ${plural(result.done.length, "item")} to trash. ${plural(result.failed.length, "item")} could not be moved; folders must be empty first.`,
        result.done.length ? undo : undefined,
      );
    else
      setNotice(
        result.done.length === 1
          ? "Moved to trash."
          : `Moved ${plural(result.done.length, "item")} to trash.`,
        undo,
      );
  }
  async function restoreItems(items: readonly DraggedItem[]) {
    setBusy(true);
    setNotice("");
    clearSelection();
    const result = await run(items, (item) =>
      command({ action: "restore", id: item.id }),
    );
    await invalidate([
      trashKey,
      ...items.map((item) => listKey("drive", item.parentId)),
    ]);
    setBusy(false);
    setNotice(
      result.failed.length
        ? failure
        : result.done.length === 1
          ? "Item restored."
          : `Restored ${plural(result.done.length, "item")}.`,
    );
  }
  async function deleteItems(items: readonly DraggedItem[]) {
    setBusy(true);
    setNotice("");
    const result = await run(items, (item) =>
      command({ action: "delete", id: item.id }),
    );
    await invalidate([trashKey]);
    setBusy(false);
    if (result.failed.length) {
      setNotice(failure);
      return;
    }
    setModal(null);
    clearSelection();
    setNotice(
      result.done.length === 1
        ? "Item permanently deleted."
        : `${plural(result.done.length, "item")} permanently deleted.`,
    );
  }

  function queueUpload(job: UploadJob) {
    if (job.plan.files.length === 0 && job.plan.folders.length === 0) return;
    queue.current.push(job);
    void drainUploads();
  }
  async function drainUploads() {
    if (controller.current) return;
    const abort = new AbortController();
    controller.current = abort;
    setNotice("");
    const affected = new Set<string | null>();
    const finished: UploadJob[] = [];
    const failed: string[] = [];
    let uploadedFiles = 0;
    try {
      const next = async (): Promise<void> => {
        const job = queue.current.shift();
        if (!job) return;
        affected.add(job.parentId);
        let current = { name: "", index: 0, total: 0 };
        failed.push(...(job.plan.skipped ?? []));
        const result = await executePlan(job.plan, job.parentId, {
          signal: abort.signal,
          step: (step) => {
            current = {
              name: step.kind === "folder" ? step.name : step.file.name,
              index: step.index + 1,
              total: step.total,
            };
            setTransfer({
              ...current,
              phase:
                step.kind === "folder" ? "Creating folder" : "Checking file",
              progress: 0,
            });
          },
          createFolder: async (folderName, folderParent) => {
            const created = await command({
              action: "folder",
              name: folderName,
              parentId: folderParent,
            });
            if (!("kind" in created)) throw new Error("Unexpected response");
            affected.add(folderParent);
            return created.id;
          },
          upload: async (file, fileParent) => {
            affected.add(fileParent);
            await uploadFile(
              file,
              fileParent,
              abort.signal,
              (phase, progress) => setTransfer({ ...current, phase, progress }),
            );
          },
        });
        uploadedFiles += result.uploaded;
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
      const done =
        created > 0
          ? `Uploaded ${plural(files, "file")} in ${plural(created, "folder")}${label}.`
          : `${files === 1 ? "File" : "Files"} uploaded${label}.`;
      const shown = failed.slice(0, 5).join(", ");
      setNotice(
        failed.length === 0
          ? done
          : `${files > 0 ? `${done} ` : ""}${plural(failed.length, "item")} could not be uploaded: ${shown}${failed.length > 5 ? "…" : ""}`,
      );
    } catch (error) {
      queue.current = [];
      setNotice(
        error instanceof DOMException && error.name === "AbortError"
          ? "Upload cancelled."
          : error instanceof Error
            ? error.message
            : "Upload failed. Please try again.",
      );
    } finally {
      controller.current = null;
      setTransfer(null);
      await invalidate([...affected].map((id) => listKey("drive", id)));
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
      setNotice("Could not read the dropped items. Try the Upload button.");
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
          setNotice(
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
        if (!check.ok) setNotice(moveRefusal(check.reason));
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
      else setNotice(`Files cannot be uploaded to ${here.name}.`);
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

  async function download(entry: DriveEntry) {
    try {
      const result = await command({ action: "download", id: entry.id });
      if (!("url" in result) || !result.url)
        throw new Error("Missing download URL");
      const anchorElement = document.createElement("a");
      anchorElement.href = result.url;
      anchorElement.download = entry.name;
      anchorElement.rel = "noopener";
      document.body.append(anchorElement);
      anchorElement.click();
      anchorElement.remove();
      if (result.url.startsWith("blob:"))
        setTimeout(() => URL.revokeObjectURL(result.url ?? ""), 60_000);
    } catch {
      setNotice("Could not download this file. Please try again.");
    }
  }
  function openEntry(entry: DriveEntry) {
    anchor.current = entry.id;
    setSelectedIds([entry.id]);
    if (entry.kind === "folder") openFolder(entry);
    else if (entry.contentType === "application/pdf" && canPreview(entry)) {
      window.open(
        driveTransport.preview(entry.id),
        "_blank",
        "noopener,noreferrer",
      );
    } else if (canPreview(entry)) {
      setPreviewUrl(driveTransport.preview(entry.id));
      setNotice("");
      setModal("preview");
    }
  }
  async function shareUser(revoke: boolean) {
    if (!selected || !userId.trim()) {
      setNotice("Enter a user ID.");
      return;
    }
    setBusy(true);
    setNotice("");
    try {
      await command(
        revoke
          ? { action: "unshare", id: selected.id, userId: userId.trim() }
          : { action: "share", id: selected.id, userId: userId.trim(), access },
      );
      setNotice(revoke ? "User access revoked." : "User access saved.");
    } catch {
      setNotice("Could not update sharing. Check access and try again.");
    } finally {
      setBusy(false);
    }
  }
  async function createLink() {
    if (!selected) return;
    const duration = Number(days);
    if (!Number.isInteger(duration) || duration < 1 || duration > 365) {
      setNotice("Choose an expiry between 1 and 365 days.");
      return;
    }
    setBusy(true);
    setNotice("");
    try {
      const result = await command({
        action: "link",
        id: selected.id,
        expiresAt: expiresAfter(duration),
      });
      if (!("token" in result)) throw new Error("Missing token");
      setLink({
        id: result.id,
        url: `${window.location.origin}/drive/api/v1/public/${encodeURIComponent(result.token)}`,
        expiresAt: result.expiresAt,
      });
    } catch {
      setNotice("Could not create a public link.");
    } finally {
      setBusy(false);
    }
  }
  async function revokeLink() {
    if (!selected || !linkId.trim()) {
      setNotice("Enter a link ID.");
      return;
    }
    setBusy(true);
    setNotice("");
    try {
      await command({
        action: "unlink",
        id: selected.id,
        linkId: linkId.trim(),
      });
      setLink(null);
      setNotice("Link revoked.");
    } catch {
      setNotice("Could not revoke the link.");
    } finally {
      setBusy(false);
    }
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
              <strong>Quota unavailable</strong>
              <small>Storage usage is not provided by the server.</small>
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
                <h1>{here.name}</h1>
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
          <output
            className={`drive-notice${notice.text && !modal ? "" : " is-empty"}`}
          >
            {notice.text && !modal && (
              <>
                <span>{notice.text}</span>
                {notice.undo && (
                  <button
                    type="button"
                    className="drive-undo"
                    onClick={notice.undo.run}
                  >
                    {notice.undo.label}
                  </button>
                )}
                <button
                  type="button"
                  className="drive-dismiss"
                  aria-label="Dismiss message"
                  onClick={() => setNotice("")}
                >
                  <Icon name="close" size={16} />
                </button>
              </>
            )}
          </output>
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
                        selected.kind !== "folder" && !canPreview(selected)
                      }
                    />
                    <Action
                      icon="download"
                      label="Download"
                      onClick={() => {
                        void download(selected);
                      }}
                      disabled={
                        selected.kind !== "file" || selected.state !== "ready"
                      }
                    />
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
        open={modal !== null}
        onOpenChange={(open) => {
          if (!open && !busy) {
            setModal(null);
            setLink(null);
            setNotice("");
          }
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
              {notice.text && (
                <p className="field-error" role="alert">
                  {notice.text}
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
            {notice.text && (
              <p className="field-error" role="alert">
                {notice.text}
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
                    setNotice(moveRefusal(check.reason));
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
            description={`This permanently deletes ${selected ? selected.name : plural(selectedEntries.length, "item")}. This cannot be undone.`}
          >
            <div className="dialog-actions">
              <Button variant="secondary" onClick={() => setModal(null)}>
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
        {modal === "preview" && selected && (
          <DialogContent title={selected.name} description="Protected preview">
            <div className="drive-preview">
              {previewUrl && (
                <iframe
                  title={`Preview of ${selected.name}`}
                  src={previewUrl}
                  sandbox=""
                />
              )}
            </div>
            <div className="dialog-actions">
              <Button
                variant="secondary"
                onClick={() => {
                  void download(selected);
                }}
              >
                Download
              </Button>
            </div>
          </DialogContent>
        )}
        {modal === "share" && selected && (
          <DialogContent
            title={`Share ${selected.name}`}
            description="Shares apply to this item only, not its contents."
          >
            <div className="drive-share">
              <TextField
                label="User ID (not email)"
                value={userId}
                onChange={(event) => setUserId(event.target.value)}
              />
              <label className="field-label" htmlFor="drive-access">
                Access
              </label>
              <select
                id="drive-access"
                className="field-input"
                value={access}
                onChange={(event) =>
                  setAccess(event.target.value === "write" ? "write" : "read")
                }
              >
                <option value="read">Can view</option>
                <option value="write">Can edit</option>
              </select>
              <div className="drive-share-buttons">
                <Button
                  size="small"
                  disabled={busy}
                  onClick={() => {
                    void shareUser(false);
                  }}
                >
                  Save access
                </Button>
                <Button
                  variant="secondary"
                  size="small"
                  disabled={busy}
                  onClick={() => {
                    void shareUser(true);
                  }}
                >
                  Revoke user
                </Button>
              </div>
              <p className="field-description">
                Existing shares are not listed by the server. Enter the
                account’s user ID (not its email address) to change or revoke
                access.
              </p>
              {selected.kind === "file" && (
                <>
                  <div className="drive-divider" />
                  <label className="field-label" htmlFor="drive-expiry">
                    Public link expiry (days)
                  </label>
                  <input
                    id="drive-expiry"
                    className="field-input"
                    type="number"
                    min="1"
                    max="365"
                    value={days}
                    onChange={(event) => setDays(event.target.value)}
                  />
                  <Button
                    variant="secondary"
                    size="small"
                    disabled={busy}
                    onClick={() => {
                      void createLink();
                    }}
                  >
                    Create public link
                  </Button>
                  {link && (
                    <div className="drive-link-result">
                      <strong>Copy this link now</strong>
                      <p>
                        The token is shown only once. Save the link ID to revoke
                        it later.
                      </p>
                      <label>
                        Public link
                        <input
                          className="field-input"
                          readOnly
                          value={link.url}
                          onFocus={(event) => event.currentTarget.select()}
                        />
                      </label>
                      <label>
                        Link ID
                        <input
                          className="field-input"
                          readOnly
                          value={link.id}
                          onFocus={(event) => event.currentTarget.select()}
                        />
                      </label>
                      <small>
                        Expires {new Date(link.expiresAt).toLocaleString()}
                      </small>
                    </div>
                  )}
                  <TextField
                    label="Link ID to revoke"
                    value={linkId}
                    onChange={(event) => setLinkId(event.target.value)}
                  />
                  <Button
                    variant="secondary"
                    size="small"
                    disabled={busy}
                    onClick={() => {
                      void revokeLink();
                    }}
                  >
                    Revoke link
                  </Button>
                </>
              )}
              {notice.text && <output>{notice.text}</output>}
            </div>
          </DialogContent>
        )}
      </Dialog>
    </Menu.Root>
  );
}
