import { z } from "zod";
import { oc } from "@orpc/contract";

export const portableExportLimits = {
  messages: 100,
  messageBytes: 10_000_000,
  totalBytes: 20_000_000,
  calendarBytes: 10_000_000,
} as const;
const id = z.string().min(1).max(256);
export const PortableExportInputSchema = z.discriminatedUnion("format", [
  z.object({
    format: z.literal("eml"),
    accountId: id,
    ids: z.array(id).length(1),
  }),
  z.object({
    format: z.literal("mbox"),
    accountId: id,
    ids: z.array(id).min(1).max(portableExportLimits.messages),
  }),
  z.object({ format: z.literal("ics"), accountId: id }),
]);
export type PortableExportInput = z.infer<typeof PortableExportInputSchema>;
export const PortableExportOutputSchema = z.object({
  filename: z.string(),
  contentType: z.string(),
  content: z.base64(),
  exported: z.number().int().nonnegative(),
  warnings: z.array(z.string()),
  failures: z.array(z.object({ id: z.string(), reason: z.string() })),
});
export type PortableExportOutput = z.infer<typeof PortableExportOutputSchema>;

export type CalendarExport = {
  root: unknown;
  exported: number;
  warnings: string[];
  failures: { id: string; reason: string }[];
  fields: Map<string, Set<string>>;
  occurrences: Map<string, Set<string>>;
};
export interface PortableExportTools {
  calendars(input: {
    origin: string;
    address: string;
    secret: string;
  }): Promise<CalendarExport>;
  addRules(root: unknown, uid: string, rules: unknown): boolean;
  addExclusion(
    root: unknown,
    uid: string,
    key: string,
    patch: unknown,
  ): boolean;
  serialize(root: unknown): Uint8Array;
  mboxMessage(raw: Uint8Array): Uint8Array;
}

const portableErrors = {
  FORBIDDEN: { status: 403, message: "Access denied" },
  NOT_FOUND: { status: 404, message: "Item not found" },
  VALIDATION: {
    status: 400,
    message: "Export exceeds a limit or contains invalid data",
  },
  CONFLICT: { status: 409, message: "Data changed during export" },
  TOO_MANY_REQUESTS: { status: 429, message: "Too many export requests" },
  UPSTREAM_UNAVAILABLE: { status: 503, message: "Export service unavailable" },
};
export const portableExportContract = {
  export: oc
    .errors(portableErrors)
    .route({ method: "POST", path: "/portable-export" })
    .input(PortableExportInputSchema)
    .output(PortableExportOutputSchema),
};
