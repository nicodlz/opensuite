import { describe, expect, it } from "vitest";
import { parseObjectPrefixes } from "../src/prefixes.ts";

const parsed = (raw: string, buffer = "messages/") => {
  const result = parseObjectPrefixes(raw, buffer);
  return result.success ? result.data : "invalid";
};

describe("receipt rule object prefixes", () => {
  it("reads a comma separated list, empty meaning the buffer prefix alone", () => {
    expect(parsed(" messages/ , messages/esuno/ ,")).toEqual([
      "messages/",
      "messages/esuno/",
    ]);
    expect(parsed("")).toBeUndefined();
    expect(parsed(" , ")).toBeUndefined();
  });

  it("refuses prefixes that could make one object answer to two IDs", () => {
    // Without a final slash, messages/esunoID matches both.
    expect(parsed("messages/,messages/esuno")).toBe("invalid");
    expect(parsed("messages/esuno/,messages/esuno/")).toBe("invalid");
    expect(parsed("other/")).toBe("invalid");
    expect(parsed("messages")).toBe("invalid");
    // Any slash-terminated prefix within an empty buffer prefix.
    expect(parsed("messages/esuno/", "")).toEqual(["messages/esuno/"]);
  });
});
