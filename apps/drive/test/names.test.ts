import { DriveCommandSchema } from "@opensuite/contracts";
import { expect, it } from "vitest";

it("accepts valid Unicode names and rejects lone surrogates for every name operation", () => {
  for (const name of ["\ud800", "\udc00", "bad\ud800name"]) {
    expect(
      DriveCommandSchema.safeParse({ action: "folder", name, parentId: null })
        .success,
    ).toBe(false);
    expect(
      DriveCommandSchema.safeParse({ action: "rename", name, id: "1" }).success,
    ).toBe(false);
    expect(
      DriveCommandSchema.safeParse({
        action: "upload",
        name,
        parentId: null,
        size: 0,
        checksum: "0".repeat(64),
        contentType: "text/plain",
        multipart: false,
      }).success,
    ).toBe(false);
  }
  expect(
    DriveCommandSchema.safeParse({
      action: "folder",
      name: "\ud83d\ude80",
      parentId: null,
    }).success,
  ).toBe(true);
});
