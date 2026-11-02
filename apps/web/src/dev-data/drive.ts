import type { DriveCommand, DriveOutput } from "@opensuite/contracts";
import type { DriveEntry } from "../drive/model.ts";

// Synthetic, in-memory data is loaded only by Vite's development build.
const now = "2026-10-28T10:30:00.000Z";
const make = (
  id: string,
  name: string,
  kind: string,
  parentId: string | null,
  size = 0,
  contentType: string | null = null,
): DriveEntry => ({
  id,
  name,
  kind,
  parentId,
  size,
  contentType,
  ownerId: "demo",
  state: "ready",
  trashedAt: null,
  createdAt: now,
});
let items: DriveEntry[] = [
  make("projects", "Projects", "folder", null),
  make("photos", "Photos", "folder", null),
  make(
    "welcome",
    "Welcome to Drive.pdf",
    "file",
    null,
    143200,
    "application/pdf",
  ),
  make("notes", "Ideas.txt", "file", "projects", 512, "text/plain"),
  {
    ...make("shared", "Shared roadmap.txt", "file", null, 1024, "text/plain"),
    ownerId: "colleague",
  },
];
// A small, valid one-page PDF so the viewer renders something real.
function samplePdf() {
  const text = "BT /F1 28 Tf 72 700 Td (Welcome to Drive) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let body = "%PDF-1.4\n";
  const offsets = objects.map((object, index) => {
    const offset = body.length;
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const xref = body.length;
  return `${body}xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join(
      "",
    )}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
}
const blobs = new Map<string, Blob>([
  ["welcome", new Blob([samplePdf()], { type: "application/pdf" })],
  ["notes", new Blob(["Project ideas"], { type: "text/plain" })],
  ["shared", new Blob(["Roadmap"], { type: "text/plain" })],
]);
const pending = new Map<string, Blob[]>();
const previews = new WeakMap<Blob, string>();
const fail = (message: string): never => {
  throw new Error(message);
};
function item(id: string) {
  return items.find((entry) => entry.id === id) ?? fail("Item not found");
}
// Mirrors the service: a folder carries its whole tree.
function tree(id: string): typeof items {
  return [
    item(id),
    ...items
      .filter((entry) => entry.parentId === id)
      .flatMap((entry) => tree(entry.id)),
  ];
}
async function command(input: DriveCommand): Promise<DriveOutput> {
  await Promise.resolve();
  if (
    sessionStorage.getItem("drive-fixture-fail-list") &&
    (input.action === "list" || input.action === "shared")
  )
    fail("Drive unavailable");
  if (
    sessionStorage.getItem("drive-fixture-fail-action") &&
    input.action !== "list" &&
    input.action !== "shared"
  )
    fail("Action failed");
  switch (input.action) {
    case "list":
      return {
        entries: items.filter(
          (entry) =>
            entry.ownerId === "demo" &&
            Boolean(entry.trashedAt) === input.trash &&
            (input.trash && input.parentId === null
              ? !items.some(
                  (parent) =>
                    parent.id === entry.parentId &&
                    parent.trashedAt === entry.trashedAt,
                )
              : entry.parentId === input.parentId),
        ),
      };
    case "shared":
      return {
        entries: items.filter(
          (entry) => entry.ownerId !== "demo" && !entry.trashedAt,
        ),
      };
    case "folder": {
      const entry = make(
        crypto.randomUUID(),
        input.name,
        "folder",
        input.parentId,
      );
      items.push(entry);
      return entry;
    }
    case "upload": {
      const entry = {
        ...make(
          crypto.randomUUID(),
          input.name,
          "file",
          input.parentId,
          input.size,
          input.contentType,
        ),
        state: "pending",
      };
      items.push(entry);
      pending.set(entry.id, []);
      return {
        id: entry.id,
        url: input.multipart ? null : `https://fixture.invalid/${entry.id}/0`,
        expiresIn: 300,
      };
    }
    case "part":
      return {
        url: `https://fixture.invalid/${input.id}/${input.partNumber}`,
        expiresIn: 300,
      };
    case "finish": {
      const entry = item(input.id);
      const data = pending.get(input.id) ?? [];
      const original = new Blob(data);
      const bytes = new Uint8Array(await original.slice(0, 12).arrayBuffer());
      const matches = (signature: number[], offset = 0) =>
        signature.every((byte, index) => bytes[offset + index] === byte);
      const safe =
        (entry.contentType === "image/png" &&
          matches([137, 80, 78, 71, 13, 10, 26, 10])) ||
        (entry.contentType === "image/jpeg" && matches([255, 216, 255])) ||
        (entry.contentType === "image/gif" &&
          (matches([71, 73, 70, 56, 55, 97]) ||
            matches([71, 73, 70, 56, 57, 97]))) ||
        (entry.contentType === "image/webp" &&
          matches([82, 73, 70, 70]) &&
          matches([87, 69, 66, 80], 8)) ||
        (entry.contentType === "application/pdf" &&
          matches([37, 80, 68, 70, 45]));
      entry.contentType = safe ? entry.contentType : "application/octet-stream";
      const blob = new Blob(data, {
        type: entry.contentType ?? "application/octet-stream",
      });
      blobs.set(input.id, blob);
      pending.delete(input.id);
      entry.state = "ready";
      return entry;
    }
    case "download": {
      const blob = blobs.get(input.id) ?? new Blob(["Demo file"]);
      return { url: URL.createObjectURL(blob), expiresIn: 300 };
    }
    case "rename": {
      const entry = item(input.id);
      entry.name = input.name;
      return entry;
    }
    case "move": {
      const entry = item(input.id);
      if (input.parentId === input.id) fail("Cannot move into itself");
      entry.parentId = input.parentId;
      return entry;
    }
    case "trash": {
      const entry = item(input.id);
      if (entry.trashedAt) return entry;
      const trashedAt = new Date().toISOString();
      for (const value of tree(entry.id)) value.trashedAt ??= trashedAt;
      return entry;
    }
    case "restore": {
      const entry = item(input.id);
      const batch = entry.trashedAt;
      if (!batch) return entry;
      for (const value of tree(entry.id))
        if (value.trashedAt === batch) value.trashedAt = null;
      const home = items.find((value) => value.id === entry.parentId);
      if (entry.parentId !== null && (!home || home.trashedAt))
        entry.parentId = null;
      return entry;
    }
    case "delete": {
      const entry = item(input.id);
      if (!entry.trashedAt) fail("Move to trash first");
      const removed = new Set(tree(entry.id).map((value) => value.id));
      items = items.filter((value) => !removed.has(value.id));
      for (const id of removed) {
        blobs.delete(id);
        pending.delete(id);
      }
      return { deleted: true };
    }
    case "share":
      return { shared: true };
    case "unshare":
    case "unlink":
      return { revoked: true };
    case "link":
      return {
        id: crypto.randomUUID(),
        token: "synthetic_token_shown_once",
        expiresAt: input.expiresAt,
      };
  }
  throw new Error("Unknown action");
}
async function put(
  url: string,
  body: Blob,
  _type: string | null,
  signal: AbortSignal,
  progress: (loaded: number) => void,
) {
  await Promise.resolve();
  signal.throwIfAborted();
  if (sessionStorage.getItem("drive-fixture-hold-upload")) {
    sessionStorage.setItem("drive-fixture-upload-started", "1");
    await new Promise<void>((_resolve, reject) => {
      signal.addEventListener(
        "abort",
        () => reject(new DOMException("Upload cancelled", "AbortError")),
        { once: true },
      );
    });
  }
  const segments = new URL(url).pathname.split("/");
  const id = segments[1] ?? "";
  const parts = pending.get(id) ?? fail("Upload not found");
  // Parts arrive in parallel; keep them in part order.
  parts[Math.max(0, Number(segments[2] ?? 0) - 1)] = body;
  progress(body.size);
  return `"part-${segments[2] ?? "0"}"`;
}
export const fakeDriveTransport = {
  command,
  put,
  zip: async (ids: string[]) => {
    await Promise.resolve();
    if (sessionStorage.getItem("drive-fixture-fail-action"))
      fail("Could not prepare ZIP download.");
    for (const id of ids)
      if (item(id).ownerId !== "demo" || item(id).trashedAt)
        fail("An item is missing, trashed, or not owned by you");
    return URL.createObjectURL(
      new Blob(["Synthetic ZIP download"], { type: "application/zip" }),
    );
  },
  // One object URL per file keeps the viewer and thumbnails stable.
  preview: (id: string) => {
    const blob = blobs.get(id);
    if (!blob) return "about:blank";
    const url = previews.get(blob) ?? URL.createObjectURL(blob);
    previews.set(blob, url);
    return url;
  },
  text: async (id: string) =>
    (blobs.get(id) ?? fail("Preview unavailable")).slice(0, 512 * 1024).text(),
};
