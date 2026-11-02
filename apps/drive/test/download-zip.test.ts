import { describe, expect, it } from "vitest";
import { safeZipName, uniqueZipName } from "../src/services/download-zip.ts";

describe("ZIP names", () => {
  it("removes path traversal, separators, absolute paths and controls", () => {
    for (const name of [
      "../secret",
      "/root\\file",
      "C:\\test\u0000.txt",
      "..",
      ".",
    ]) {
      const safe = safeZipName(name);
      expect(safe).not.toContain("..");
      expect(
        safe
          .split("")
          .some(
            (c) =>
              c.charCodeAt(0) < 32 ||
              (c.charCodeAt(0) >= 127 && c.charCodeAt(0) <= 159) ||
              "/\\:".includes(c),
          ),
      ).toBe(false);
      expect(safe).not.toBe("");
    }
    expect(safeZipName("Quarterly report.pdf")).toBe("Quarterly report.pdf");
  });
  it("deduplicates names after sanitizing while retaining extensions", () => {
    const used = new Set<string>();
    expect(
      ["a.txt", "a.txt", "a (1).txt", "a.txt"].map((name) =>
        uniqueZipName(name, used),
      ),
    ).toEqual(["a.txt", "a (1).txt", "a (1) (1).txt", "a (2).txt"]);
    expect(uniqueZipName("x/y.txt", used)).toBe("x_y.txt");
    expect(uniqueZipName("x\\y.txt", used)).toBe("x_y (1).txt");
  });
});

it("stops the active object and does not open the next one when the archive is cancelled", async () => {
  const { Readable } = await import("node:stream");
  const { vi } = await import("vitest");
  const { zipStream } = await import("../src/adapters/zip-stream.ts");
  const source = new Readable({
    read() {
      this.push(Buffer.alloc(64 * 1024, 7));
    },
  });
  const get = vi.fn(() => Promise.resolve(source));
  const entry = {
    id: "one",
    ownerId: "owner",
    parentId: null,
    name: "one",
    kind: "file",
    state: "ready",
    size: 10_000_000n,
    checksum: null,
    contentType: null,
    objectKey: "one",
    uploadId: null,
    expiresAt: null,
    trashedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const stream = zipStream(
    [
      { path: "one", entry },
      { path: "two", entry: { ...entry, id: "two", objectKey: "two" } },
    ],
    get,
  );
  stream.once("data", () => stream.destroy());
  await new Promise<void>((resolve) => stream.once("close", resolve));
  expect(source.destroyed).toBe(true);
  expect(get).toHaveBeenCalledTimes(1);
});

it("fails the archive if storage cannot open an object", async () => {
  const { zipStream } = await import("../src/adapters/zip-stream.ts");
  const entry = {
    id: "one",
    ownerId: "owner",
    parentId: null,
    name: "one",
    kind: "file",
    state: "ready",
    size: 4n,
    checksum: null,
    contentType: null,
    objectKey: "one",
    uploadId: null,
    expiresAt: null,
    trashedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const stream = zipStream([{ path: "one", entry }], () =>
    Promise.reject(new Error("storage unavailable")),
  );
  stream.resume();
  const failure = new Promise<Error>((resolve) =>
    stream.once("error", resolve),
  );
  await expect(failure).resolves.toMatchObject({
    message: "storage unavailable",
  });
});
