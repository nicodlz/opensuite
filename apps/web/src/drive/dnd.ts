// Pure drag-and-drop helpers for Drive. Browser drag events stay in the page.

/** MIME type that marks a drag of Drive items started in this application. */
export const DRIVE_ITEMS_TYPE = "application/x-opensuite-drive-items";

export type DragKind = "items" | "files" | null;

/** Identifies what is being dragged from `DataTransfer.types` alone. */
export function dragKind(types: Iterable<string> | null | undefined): DragKind {
  const list = types ? Array.from(types) : [];
  if (list.includes(DRIVE_ITEMS_TYPE)) return "items";
  if (list.includes("Files")) return "files";
  return null;
}

export type DraggedItem = {
  id: string;
  kind: string;
  parentId: string | null;
  name: string;
};

export function encodeItems(items: readonly DraggedItem[]) {
  return JSON.stringify(
    items.map(({ id, kind, parentId, name }) => ({ id, kind, parentId, name })),
  );
}

function isDraggedItem(value: unknown): value is DraggedItem {
  if (typeof value !== "object" || value === null) return false;
  const record: Record<string, unknown> = { ...value };
  return (
    typeof record["id"] === "string" &&
    typeof record["kind"] === "string" &&
    typeof record["name"] === "string" &&
    (record["parentId"] === null || typeof record["parentId"] === "string")
  );
}

/** Reads items written by `encodeItems`; anything malformed yields no items. */
export function decodeItems(value: string): DraggedItem[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every(isDraggedItem) ? parsed : [];
  } catch {
    return [];
  }
}

export type MoveCheck =
  | { ok: true; items: DraggedItem[] }
  | { ok: false; reason: "empty" | "self" | "same-parent" };

/**
 * Validates moving `items` into `targetId`. `targetPath` lists the folder ids
 * from the root down to the target, so an item found there would be moved into
 * itself or one of its descendants. Items already in the target are skipped.
 */
export function checkMove(
  items: readonly DraggedItem[],
  targetId: string | null,
  targetPath: readonly (string | null)[],
): MoveCheck {
  if (items.length === 0) return { ok: false, reason: "empty" };
  const chain = new Set([...targetPath, targetId]);
  if (items.some((item) => chain.has(item.id)))
    return { ok: false, reason: "self" };
  const moving = items.filter((item) => item.parentId !== targetId);
  return moving.length === 0
    ? { ok: false, reason: "same-parent" }
    : { ok: true, items: moving };
}

export function moveRefusal(reason: "empty" | "self" | "same-parent") {
  return reason === "self"
    ? "A folder cannot be moved into itself or one of its subfolders."
    : reason === "same-parent"
      ? "Already in this folder."
      : "Nothing to move.";
}

// Minimal shapes of the File and Directory Entries API, satisfied by the DOM types.
export interface DropEntry {
  readonly name: string;
  readonly isFile: boolean;
  readonly isDirectory: boolean;
}
interface DropFileEntry extends DropEntry {
  file(
    success: (file: File) => void,
    error?: (error: DOMException) => void,
  ): void;
}
interface DropDirectoryReader {
  readEntries(
    success: (entries: DropEntry[]) => void,
    error?: (error: DOMException) => void,
  ): void;
}
interface DropDirectoryEntry extends DropEntry {
  createReader(): DropDirectoryReader;
}
const isFileEntry = (entry: DropEntry): entry is DropFileEntry =>
  entry.isFile && "file" in entry;
const isDirectoryEntry = (entry: DropEntry): entry is DropDirectoryEntry =>
  entry.isDirectory && "createReader" in entry;

/** One dropped item: its entry when the browser exposes one, otherwise its file. */
export type DropSource = { entry: DropEntry | null; file: File | null };

/** Folders to create and files to upload, with paths relative to the drop target. */
export type UploadPlan = {
  /** Folder paths, parents before children. */
  folders: string[][];
  /** Files with the path of the folder that contains them. */
  files: { file: File; path: string[] }[];
};

function readBatch(reader: DropDirectoryReader) {
  return new Promise<DropEntry[]>((resolve, reject) => {
    reader.readEntries(resolve, reject);
  });
}
/** `readEntries` returns entries in batches; read until it returns none. */
export async function readAllEntries(
  reader: DropDirectoryReader,
  found: DropEntry[] = [],
): Promise<DropEntry[]> {
  const batch = await readBatch(reader);
  return batch.length === 0
    ? found
    : readAllEntries(reader, [...found, ...batch]);
}

function sequence<T>(values: readonly T[], run: (value: T) => Promise<void>) {
  return values.reduce<Promise<void>>(async (previous, value) => {
    await previous;
    await run(value);
  }, Promise.resolve());
}

async function walk(entry: DropEntry, path: string[], plan: UploadPlan) {
  if (isFileEntry(entry)) {
    const file = await new Promise<File>((resolve, reject) => {
      entry.file(resolve, reject);
    });
    plan.files.push({ file, path });
  } else if (isDirectoryEntry(entry)) {
    const folder = [...path, entry.name];
    plan.folders.push(folder);
    const children = await readAllEntries(entry.createReader());
    await sequence(children, (child) => walk(child, folder, plan));
  }
}

/** Expands dropped files and folders into an upload plan. */
export async function planDrop(sources: readonly DropSource[]) {
  const plan: UploadPlan = { folders: [], files: [] };
  await sequence(sources, async (source) => {
    if (source.entry) await walk(source.entry, [], plan);
    else if (source.file) plan.files.push({ file: source.file, path: [] });
  });
  return plan;
}

/** Builds a plan from a folder picker, which sets `webkitRelativePath`. */
export function planFromFiles(files: readonly File[]): UploadPlan {
  const folders = new Map<string, string[]>();
  const planned = files.map((file) => {
    const segments = (file.webkitRelativePath || file.name)
      .split("/")
      .filter(Boolean);
    const path = segments.slice(0, -1);
    path.forEach((_segment, index) => {
      const prefix = path.slice(0, index + 1);
      folders.set(folderKey(prefix), prefix);
    });
    return { file, path };
  });
  return { folders: [...folders.values()], files: planned };
}

function folderKey(path: readonly string[]) {
  return path.join("\u0000");
}

export type PlanStep =
  | { kind: "folder"; name: string; index: number; total: number }
  | { kind: "file"; file: File; index: number; total: number };

/**
 * Creates the plan's folders below `rootId`, then uploads its files into them,
 * one step at a time. Returns how many files were uploaded.
 */
export async function executePlan(
  plan: UploadPlan,
  rootId: string | null,
  actions: {
    createFolder: (name: string, parentId: string | null) => Promise<string>;
    upload: (file: File, parentId: string | null) => Promise<void>;
    step?: (step: PlanStep) => void;
    signal?: AbortSignal;
  },
) {
  const ids = new Map<string, string | null>([["", rootId]]);
  const parentOf = (path: readonly string[]) => {
    const id = ids.get(folderKey(path));
    if (id === undefined) throw new Error("Parent folder was not created");
    return id;
  };
  await sequence(
    plan.folders.map((path, index) => ({ path, index })),
    async ({ path, index }) => {
      actions.signal?.throwIfAborted();
      const name = path.at(-1) ?? "";
      actions.step?.({
        kind: "folder",
        name,
        index,
        total: plan.folders.length,
      });
      ids.set(
        folderKey(path),
        await actions.createFolder(name, parentOf(path.slice(0, -1))),
      );
    },
  );
  await sequence(
    plan.files.map((item, index) => ({ ...item, index })),
    async ({ file, path, index }) => {
      actions.signal?.throwIfAborted();
      actions.step?.({ kind: "file", file, index, total: plan.files.length });
      await actions.upload(file, parentOf(path));
    },
  );
  return plan.files.length;
}
