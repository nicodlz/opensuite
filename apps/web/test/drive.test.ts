// @vitest-environment jsdom
import { createHash, randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DriveCommandSchema,
  DRIVE_MAX_FILE_SIZE,
  drivePartSize,
} from "@opensuite/contracts";
import { Sha256 } from "../src/drive/hash.ts";
import type * as HashModule from "../src/drive/hash.ts";
import { driveTransport, uploadFile } from "../src/drive/client.ts";
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
  readAllEntries,
  type DropEntry,
} from "../src/drive/dnd.ts";
import {
  canPreview,
  formatBytes,
  sortEntries,
  validName,
  type DriveEntry,
} from "../src/drive/model.ts";

vi.mock("../src/drive/hash.ts", async (importOriginal) => {
  const original = await importOriginal<typeof HashModule>();
  return {
    ...original,
    hashFile: vi
      .fn<typeof HashModule.hashFile>()
      .mockResolvedValue("0".repeat(64)),
  };
});
afterEach(() => vi.restoreAllMocks());

describe("Drive upload hashing", () => {
  it("matches SHA-256 across block and chunk boundaries", () => {
    for (const size of [0, 3, 55, 56, 64, 65, 1024 * 1024 + 13]) {
      const data = randomBytes(size);
      const hash = new Sha256();
      for (let i = 0; i < data.length; i += 37)
        hash.update(data.subarray(i, i + 37));
      expect(hash.digest()).toBe(
        createHash("sha256").update(data).digest("hex"),
      );
    }
  });
  it("hashes a file across chunks and stops when cancelled", async () => {
    const { hashFile } = await vi.importActual<typeof HashModule>(
      "../src/drive/hash.ts",
    );
    const bytes = randomBytes(1024 * 1024 + 13);
    const file = new Blob([Uint8Array.from(bytes)]);
    vi.spyOn(file, "slice").mockImplementation(
      (start = 0, end = bytes.length) => {
        const chunk = new Blob();
        const data = bytes.subarray(start, end);
        Object.defineProperty(chunk, "arrayBuffer", {
          value: () => Promise.resolve(Uint8Array.from(data).buffer),
        });
        return chunk;
      },
    );
    const progress: number[] = [];
    const signal = new AbortController();
    expect(
      await hashFile(file, signal.signal, (fraction) =>
        progress.push(fraction),
      ),
    ).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(progress).toHaveLength(2);
    expect(progress.at(-1)).toBe(1);
    const cancelled = new AbortController();
    await expect(
      hashFile(file, cancelled.signal, () => cancelled.abort()),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});
it("accepts files above 5 GB and sizes parts within the multipart limit", () => {
  const input = {
    action: "upload",
    name: "large.bin",
    parentId: null,
    checksum: "0".repeat(64),
    contentType: "application/octet-stream",
    multipart: true,
  };
  for (const size of [5_000_000_001, 60_000_000_000, DRIVE_MAX_FILE_SIZE]) {
    expect(DriveCommandSchema.safeParse({ ...input, size }).success).toBe(true);
    expect(Math.ceil(size / drivePartSize(size))).toBeLessThanOrEqual(10_000);
    expect(drivePartSize(size)).toBeLessThanOrEqual(5 * 1024 ** 3);
  }
  expect(
    DriveCommandSchema.safeParse({ ...input, size: DRIVE_MAX_FILE_SIZE + 1 })
      .success,
  ).toBe(false);
});
it("uploads a file larger than 5 GB through multipart finalization", async () => {
  const size = 5_000_000_001;
  const file = new File(["x"], "large.bin", {
    type: "application/octet-stream",
  });
  Object.defineProperty(file, "size", { value: size });
  vi.spyOn(file, "slice").mockReturnValue(new Blob(["part"]));
  const commands: string[] = [];
  const request = vi
    .spyOn(driveTransport, "command")
    .mockImplementation((input) => {
      commands.push(input.action);
      if (input.action === "upload") {
        return Promise.resolve({ id: "file", url: null, expiresIn: 300 });
      }
      if (input.action === "part")
        return Promise.resolve({
          url: "https://storage.test/part",
          expiresIn: 300,
        });
      if (input.action === "finish") {
        return Promise.resolve({ deleted: true });
      }
      return Promise.reject(new Error("Unexpected command"));
    });
  const put = vi.spyOn(driveTransport, "put").mockResolvedValue('"etag"');
  await uploadFile(file, null, new AbortController().signal, () => {});
  expect(put).toHaveBeenCalledTimes(Math.ceil(size / drivePartSize(size)));
  expect(commands.at(-1)).toBe("finish");
  expect(request.mock.calls[0]?.[0]).toEqual(
    expect.objectContaining({ action: "upload", size, multipart: true }),
  );
  const last = request.mock.calls.at(-1)?.[0];
  expect(last?.action).toBe("finish");
  expect(last?.action === "finish" ? last.parts : undefined).toHaveLength(
    Math.ceil(size / drivePartSize(size)),
  );
});
describe("Drive presentation helpers", () => {
  const file: DriveEntry = {
    id: "file",
    ownerId: "owner",
    parentId: null,
    name: "A",
    kind: "file",
    state: "ready",
    size: 1024,
    contentType: "image/png",
    trashedAt: null,
    createdAt: "2026-01-01",
  };
  it("allows only verified preview formats and ready files", () => {
    expect(canPreview(file)).toBe(true);
    expect(canPreview({ ...file, contentType: "image/svg+xml" })).toBe(false);
    expect(canPreview({ ...file, contentType: "text/html" })).toBe(false);
    expect(canPreview({ ...file, state: "pending" })).toBe(false);
    expect(canPreview({ ...file, kind: "folder" })).toBe(false);
  });
  it("validates names, formats sizes, and sorts folders first", () => {
    expect(validName("Project notes.txt")).toBe(true);
    expect(validName("bad/name")).toBe(false);
    expect(validName("bad\\name")).toBe(false);
    expect(validName("")).toBe(false);
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(
      sortEntries([
        file,
        { ...file, id: "folder", name: "Z", kind: "folder" },
      ]).map((entry) => entry.id),
    ).toEqual(["folder", "file"]);
  });
});

function fileEntry(name: string) {
  return {
    name,
    isFile: true,
    isDirectory: false,
    file: (success: (file: File) => void) => success(new File([name], name)),
  };
}
function directoryEntry(name: string, children: DropEntry[]) {
  return {
    name,
    isFile: false,
    isDirectory: true,
    createReader: () => {
      let offset = 0;
      // Browsers return directory contents in batches; mimic batches of two.
      return {
        readEntries: (success: (entries: DropEntry[]) => void) => {
          const batch = children.slice(offset, offset + 2);
          offset += batch.length;
          success(batch);
        },
      };
    },
  };
}
function pickedFile(path: string) {
  const value = new File(["x"], path.split("/").at(-1) ?? path);
  Object.defineProperty(value, "webkitRelativePath", { value: path });
  return value;
}
const item = (id: string, parentId: string | null, kind = "file") => ({
  id,
  parentId,
  kind,
  name: id,
});
describe("Drive drag and drop", () => {
  it("sniffs drag types without reading the data", () => {
    expect(dragKind(["Files"])).toBe("files");
    expect(dragKind([DRIVE_ITEMS_TYPE, "Files"])).toBe("items");
    expect(dragKind(["text/plain", "text/uri-list"])).toBeNull();
    expect(dragKind(null)).toBeNull();
  });
  it("round-trips dragged items and rejects malformed data", () => {
    const items = [item("a", null), item("b", "folder", "folder")];
    expect(decodeItems(encodeItems(items))).toEqual(items);
    expect(decodeItems("not json")).toEqual([]);
    expect(decodeItems(JSON.stringify([{ id: 1 }]))).toEqual([]);
    expect(decodeItems(JSON.stringify({ id: "a" }))).toEqual([]);
  });
  it("refuses moves into the item itself, a descendant or its parent", () => {
    const folder = item("projects", null, "folder");
    expect(checkMove([folder], "projects", [null, "projects"])).toEqual({
      ok: false,
      reason: "self",
    });
    expect(
      checkMove([folder], "deep", [null, "projects", "child", "deep"]),
    ).toEqual({ ok: false, reason: "self" });
    expect(checkMove([folder], null, [null])).toEqual({
      ok: false,
      reason: "same-parent",
    });
    expect(checkMove([], "photos", [null, "photos"])).toEqual({
      ok: false,
      reason: "empty",
    });
    const file = item("notes", "photos");
    expect(checkMove([folder, file], "photos", [null, "photos"])).toEqual({
      ok: true,
      items: [folder],
    });
    expect(checkMove([file], null, [null])).toEqual({
      ok: true,
      items: [file],
    });
    expect(moveRefusal("self")).toMatch(/into itself/);
  });
  it("reads directories until readEntries returns no entries", async () => {
    const children = ["1", "2", "3", "4", "5"].map(fileEntry);
    const directory = directoryEntry("many", children);
    await expect(readAllEntries(directory.createReader())).resolves.toEqual(
      children,
    );
  });
  it("plans folder hierarchies from dropped entries", async () => {
    const loose = new File(["loose"], "loose.txt");
    const plan = await planDrop([
      {
        entry: directoryEntry("Album", [
          fileEntry("a.jpg"),
          directoryEntry("Raw", [fileEntry("b.raw"), fileEntry("c.raw")]),
          directoryEntry("Empty", []),
        ]),
        file: null,
      },
      { entry: fileEntry("top.txt"), file: null },
      { entry: null, file: loose },
    ]);
    expect(plan.folders).toEqual([
      ["Album"],
      ["Album", "Raw"],
      ["Album", "Empty"],
    ]);
    expect(
      plan.files.map(({ file, path }) => [path.join("/"), file.name]),
    ).toEqual([
      ["Album", "a.jpg"],
      ["Album/Raw", "b.raw"],
      ["Album/Raw", "c.raw"],
      ["", "top.txt"],
      ["", "loose.txt"],
    ]);
  });
  it("plans folders from a folder picker's relative paths", () => {
    const plan = planFromFiles([
      pickedFile("Site/index.html"),
      pickedFile("Site/css/main.css"),
      pickedFile("Site/css/print.css"),
    ]);
    expect(plan.folders).toEqual([["Site"], ["Site", "css"]]);
    expect(plan.files.map(({ path }) => path.join("/"))).toEqual([
      "Site",
      "Site/css",
      "Site/css",
    ]);
  });
  it("creates folders before uploading files into them", async () => {
    const calls: string[] = [];
    const plan = await planDrop([
      {
        entry: directoryEntry("Album", [
          directoryEntry("Raw", [fileEntry("b.raw")]),
          fileEntry("a.jpg"),
        ]),
        file: null,
      },
    ]);
    const uploaded = await executePlan(plan, "target", {
      createFolder: (name, parentId) => {
        calls.push(`folder ${name} in ${parentId ?? "root"}`);
        return Promise.resolve(`id-${name}`);
      },
      upload: (file, parentId) => {
        calls.push(`file ${file.name} in ${parentId ?? "root"}`);
        return Promise.resolve();
      },
    });
    expect(uploaded).toEqual({ uploaded: 2, failed: [] });
    expect(calls).toEqual([
      "folder Album in target",
      "folder Raw in id-Album",
      "file b.raw in id-Raw",
      "file a.jpg in id-Album",
    ]);
  });
  it("skips unreadable or failing items and uploads the rest", async () => {
    const broken = {
      name: "locked.bin",
      isFile: true,
      isDirectory: false,
      file: (_success: (file: File) => void, failure: (error: Error) => void) =>
        failure(new Error("NotReadableError")),
    };
    const plan = await planDrop([
      {
        entry: directoryEntry("Docs", [
          fileEntry("a.txt"),
          broken,
          fileEntry("bad\\name.txt"),
          fileEntry("c.txt"),
        ]),
        file: null,
      },
    ]);
    expect(plan.skipped).toEqual(["Docs/locked.bin"]);
    const result = await executePlan(plan, "target", {
      createFolder: (name) => Promise.resolve(`id-${name}`),
      upload: (file) =>
        file.name.includes("\\")
          ? Promise.reject(new Error("invalid name"))
          : Promise.resolve(),
    });
    expect(result).toEqual({
      uploaded: 2,
      failed: ["Docs/bad\\name.txt"],
    });
  });
  it("stops a plan when it is cancelled", async () => {
    const controller = new AbortController();
    const upload = vi.fn<
      (file: File, parentId: string | null) => Promise<void>
    >(() => {
      controller.abort();
      return Promise.resolve();
    });
    await expect(
      executePlan(
        {
          folders: [],
          files: [
            { file: new File(["1"], "1.txt"), path: [] },
            { file: new File(["2"], "2.txt"), path: [] },
          ],
        },
        null,
        {
          createFolder: () => Promise.resolve("unused"),
          upload,
          signal: controller.signal,
        },
      ),
    ).rejects.toThrow("aborted");
    expect(upload).toHaveBeenCalledTimes(1);
  });
});
