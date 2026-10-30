import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Sha256 } from "../src/drive/hash.ts";
import {
  canPreview,
  formatBytes,
  sortEntries,
  validName,
  type DriveEntry,
} from "../src/drive/model.ts";

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
