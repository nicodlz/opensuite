import { ORPCError } from "@orpc/server";
import type { Entry, PrismaClient } from "../db/generated/index.js";

export type ZipLimits = { maxEntries: number; maxBytes: number };
export type ZipItem = { path: string; entry: Entry };
const invalid = (message: string) => new ORPCError("BAD_REQUEST", { message });

export function safeZipName(name: string): string {
  const clean = Array.from(name.toWellFormed(), (char) => {
    const code = char.codePointAt(0) ?? 0;
    return code < 32 || (code >= 127 && code <= 159) || "/\\:".includes(char)
      ? "_"
      : char;
  })
    .join("")
    .replace(/\.\./g, "_")
    .trim()
    .replace(/[. ]+$/g, "");
  return clean === "" || clean === "." ? "_" : clean;
}

export function uniqueZipName(name: string, used: Set<string>): string {
  const clean = safeZipName(name);
  const dot = clean.lastIndexOf(".");
  const stem = dot > 0 ? clean.slice(0, dot) : clean;
  const ext = dot > 0 ? clean.slice(dot) : "";
  let candidate = clean;
  for (let n = 1; used.has(candidate); n++)
    candidate = `${stem} (${String(n)})${ext}`;
  used.add(candidate);
  return candidate;
}

const compare = (a: Entry, b: Entry) =>
  a.name < b.name
    ? -1
    : a.name > b.name
      ? 1
      : a.id < b.id
        ? -1
        : a.id > b.id
          ? 1
          : 0;

/** Validate the whole selection and build bounded metadata before opening storage. */
export async function prepareZip(
  db: PrismaClient,
  owner: string,
  ids: string[],
  limits: ZipLimits,
): Promise<ZipItem[]> {
  const unique = [...new Set(ids)];
  if (
    unique.length === 0 ||
    unique.length !== ids.length ||
    unique.length > 100
  )
    throw invalid("Select between 1 and 100 distinct items");
  const roots = await db.entry.findMany({
    where: { id: { in: unique }, ownerId: owner, trashedAt: null },
  });
  if (roots.length !== unique.length)
    throw invalid("An item is missing, trashed, or not owned by you");
  const found = new Map<string, Entry>();
  let bytes = 0n;
  const pending: Entry[] = [];
  const add = (entry: Entry) => {
    if (found.has(entry.id)) return;
    if (
      entry.state !== "ready" ||
      (entry.kind !== "file" && entry.kind !== "folder") ||
      (entry.kind === "file" && entry.objectKey === null)
    )
      throw invalid("An item is not ready for download");
    found.set(entry.id, entry);
    if (entry.kind === "file") bytes += entry.size;
    if (entry.size < 0n || bytes > BigInt(limits.maxBytes))
      throw invalid("ZIP size limit exceeded");
    if (found.size > limits.maxEntries)
      throw invalid("ZIP entry limit exceeded");
    if (entry.kind === "folder") pending.push(entry);
  };
  for (const entry of roots) add(entry);
  while (pending.length) {
    const entry = pending.pop();
    if (!entry) continue;
    // Bound each traversal before querying the next folder.
    // oxlint-disable-next-line eslint/no-await-in-loop
    const children = await db.entry.findMany({
      where: { ownerId: owner, parentId: entry.id, trashedAt: null },
      take: limits.maxEntries + 1,
    });
    if (children.length > limits.maxEntries)
      throw invalid("ZIP entry limit exceeded");
    for (const child of children) add(child);
  }
  return paths(found);
}

function paths(found: Map<string, Entry>): ZipItem[] {
  const children = new Map<string | null, Entry[]>();
  for (const entry of found.values()) {
    const parent =
      entry.parentId !== null && found.has(entry.parentId)
        ? entry.parentId
        : null;
    const siblings = children.get(parent) ?? [];
    siblings.push(entry);
    children.set(parent, siblings);
  }
  const output: ZipItem[] = [];
  const todo: { parent: string | null; prefix: string }[] = [
    { parent: null, prefix: "" },
  ];
  while (todo.length) {
    const current = todo.pop();
    if (!current) break;
    const used = new Set<string>();
    for (const entry of (children.get(current.parent) ?? []).toSorted(
      compare,
    )) {
      const path = current.prefix + uniqueZipName(entry.name, used);
      if (
        Buffer.byteLength(path + (entry.kind === "folder" ? "/" : "")) > 65535
      )
        throw invalid("ZIP path is too long");
      output.push({ path, entry });
      if (entry.kind === "folder")
        todo.push({ parent: entry.id, prefix: `${path}/` });
    }
  }
  if (output.length !== found.size) throw invalid("Invalid folder structure");
  return output;
}

export const zip = (db: PrismaClient) => ({
  prepareZip: (user: string, ids: string[], limits: ZipLimits) =>
    prepareZip(db, user, ids, limits),
});
