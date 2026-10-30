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
const blobs = new Map<string, Blob>([
  ["welcome", new Blob(["%PDF-1.4\n%%EOF"], { type: "application/pdf" })],
  ["notes", new Blob(["Project ideas"], { type: "text/plain" })],
  ["shared", new Blob(["Roadmap"], { type: "text/plain" })],
]);
const pending = new Map<string, Blob[]>();
const fail = (message: string): never => {
  throw new Error(message);
};
function item(id: string) {
  return items.find((entry) => entry.id === id) ?? fail("Item not found");
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
            entry.parentId === input.parentId &&
            Boolean(entry.trashedAt) === input.trash,
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
      if (
        entry.kind === "folder" &&
        items.some((child) => child.parentId === entry.id)
      )
        fail("Folder must be empty");
      entry.trashedAt = new Date().toISOString();
      return entry;
    }
    case "restore": {
      const entry = item(input.id);
      entry.trashedAt = null;
      return entry;
    }
    case "delete": {
      const entry = item(input.id);
      if (!entry.trashedAt) fail("Move to trash first");
      items = items.filter((value) => value.id !== input.id);
      blobs.delete(input.id);
      pending.delete(input.id);
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
  parts.push(body);
  progress(body.size);
  return `"part-${segments[2] ?? "0"}"`;
}
export const fakeDriveTransport = {
  command,
  put,
  preview: (id: string) => {
    const blob = blobs.get(id);
    return blob ? URL.createObjectURL(blob) : "about:blank";
  },
};
