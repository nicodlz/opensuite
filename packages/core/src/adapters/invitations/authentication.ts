import type { simpleParser } from "mailparser";
import { z } from "zod";

const parsedHeader = z.object({
  value: z.string(),
  params: z.record(z.string(), z.string()),
});

function signingDomain(line: string, parsed: unknown): string | undefined {
  const structured = parsedHeader.safeParse(parsed);
  if (!structured.success) return undefined;
  const value = line.slice(line.indexOf(":") + 1);
  // libmime normalizes tag names and keeps one duplicate; reject ambiguity.
  // A body-length tag can leave the calendar part outside the signature.
  if (/(?:^|;)[ \t\r\n]*l[ \t\r\n]*=/.test(value)) return undefined;
  if ([...value.matchAll(/(?:^|;)[ \t\r\n]*d[ \t\r\n]*=/g)].length !== 1)
    return undefined;
  const raw =
    /(?:^|;)[ \t\r\n]*d[ \t\r\n]*=[ \t\r\n]*([^;\s]+)[ \t\r\n]*(?=;|$)/.exec(
      value,
    )?.[1];
  const first = /^d[ \t]*=[ \t]*([^;\s]+)[ \t]*$/.exec(
    structured.data.value,
  )?.[1];
  const decoded = structured.data.params["d"] ?? first;
  return raw && decoded && raw.toLowerCase() === decoded.toLowerCase()
    ? raw
    : undefined;
}

/** Use parsed MIME headers, rejecting missing, ambiguous or excessive signatures. */
export function signingDomains(
  message: Awaited<ReturnType<typeof simpleParser>>,
): string[] {
  const lines = message.headerLines.filter(
    (header) => header.key === "dkim-signature",
  );
  if (!lines.length || lines.length > 20) return [];
  const value = message.headers.get("dkim-signature");
  const parsed = Array.isArray(value)
    ? value
    : value === undefined
      ? []
      : [value];
  if (parsed.length !== lines.length) return [];
  const domains = lines.map((line, index) =>
    signingDomain(line.line, parsed[index]),
  );
  return domains.every((domain) => domain !== undefined) ? domains : [];
}
