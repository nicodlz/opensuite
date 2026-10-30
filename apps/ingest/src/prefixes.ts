import { z } from "zod";

/**
 * Receipt rules' object key prefixes, comma separated. Each must be distinct,
 * end with a slash and lie within the buffer prefix: without the slash,
 * `messages/` and `messages/esuno` would both match `messages/esunoID`, so
 * one object would answer to two message IDs. Empty means the buffer prefix
 * alone.
 */
export function parseObjectPrefixes(
  raw: string,
  bufferPrefix: string,
): z.ZodSafeParseResult<string[] | undefined> {
  const items = raw
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "");
  return z
    .array(
      z
        .string()
        .refine((item) => item.endsWith("/"), "must end with a slash")
        .refine(
          (item) => item.startsWith(bufferPrefix),
          "must lie within the buffer prefix",
        ),
    )
    .refine((list) => new Set(list).size === list.length, "must be distinct")
    .transform((list) => (list.length > 0 ? list : undefined))
    .safeParse(items);
}
