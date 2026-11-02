import { oc } from "@orpc/contract";
import { z } from "zod";
import { IdSchema } from "./mail.ts";

export const MAIL_ARCHIVE_LIMIT = 8 * 1024 * 1024;
export const MAIL_MESSAGE_LIMIT = 4 * 1024 * 1024;
export const MAIL_IMPORT_LIMITATIONS = [
  "Archives are limited to 8 MiB, individual messages to 4 MiB, and jobs to 1,000 messages.",
  "MBOX messages are limited to 100,000 lines; compressed and Content-Length-framed archives are not supported.",
  "Only explicitly mapped Gmail labels are assigned to mailboxes; other labels are not mapped.",
  "Gmail labels containing commas cannot be distinguished from multiple labels.",
  "Mboxo cannot distinguish original From quoting; choose mboxrd only for mboxrd archives.",
  "Messages without a reliable Message-ID cannot be deduplicated. Conflicting IDs and uncertain imports require attention.",
  "Duplicate checks scan at most 1,000,000 destination messages and retain at most 10,000 matching candidates per job.",
  "Dates missing from message headers and unsupported source flags cannot be preserved.",
  "Envelope dates without a clear time zone fall back to the message Date header.",
];
const account = z.object({ accountId: IdSchema });
const jobInput = account.extend({ jobId: IdSchema });
export const MailImportInputSchema = account.extend({
  format: z.enum(["eml", "mbox"]),
  variant: z.enum(["mboxo", "mboxrd"]).default("mboxo"),
  base64: z.base64().max(Math.ceil(MAIL_ARCHIVE_LIMIT / 3) * 4),
  mailboxId: IdSchema,
  labels: z.record(z.string().min(1).max(200), IdSchema).default({}),
});
const entry = z.object({
  index: z.number().int().nonnegative(),
  status: z.enum([
    "pending",
    "importing",
    "imported",
    "duplicate",
    "failed",
    "uncertain",
  ]),
  error: z.string().nullable(),
});
export const MailImportReportSchema = z.object({
  id: IdSchema,
  status: z.enum(["queued", "running", "completed", "cancelled", "attention"]),
  cancelRequested: z.boolean(),
  error: z.string().nullable(),
  total: z.number().int().nonnegative(),
  processed: z.number().int().nonnegative(),
  messages: z.array(entry),
  limitations: z.array(z.string()),
});
const procedure = oc.errors({
  FORBIDDEN: { status: 403, message: "Access denied" },
  NOT_FOUND: { status: 404, message: "Import not found" },
  VALIDATION: { status: 400, message: "Invalid import" },
  CONFLICT: { status: 409, message: "Import already active" },
  TOO_MANY_REQUESTS: { status: 429, message: "Too many import requests" },
  UPSTREAM_UNAVAILABLE: { status: 503, message: "Import service unavailable" },
});
export const migrationMailContract = {
  list: procedure
    .route({ method: "POST", path: "/mail/imports/list" })
    .input(account)
    .output(
      z.object({
        jobs: z.array(
          z.object({
            id: IdSchema,
            status: MailImportReportSchema.shape.status,
            createdAt: z.iso.datetime(),
          }),
        ),
      }),
    ),
  create: procedure
    .route({ method: "POST", path: "/mail/imports/create" })
    .input(MailImportInputSchema)
    .output(MailImportReportSchema),
  report: procedure
    .route({ method: "POST", path: "/mail/imports/report" })
    .input(jobInput)
    .output(MailImportReportSchema),
  cancel: procedure
    .route({ method: "POST", path: "/mail/imports/cancel" })
    .input(jobInput)
    .output(MailImportReportSchema),
  resume: procedure
    .route({ method: "POST", path: "/mail/imports/resume" })
    .input(jobInput)
    .output(MailImportReportSchema),
};
export type MailImportInput = z.infer<typeof MailImportInputSchema>;
export type MailImportReport = z.infer<typeof MailImportReportSchema>;

export interface MailImportMetadata {
  messageId: string | null;
  mailboxIds: Record<string, boolean>;
  keywords: Record<string, boolean>;
  receivedAt?: string;
}
export type MailImportInspection =
  { kind: "match"; id: string } | { kind: "none" | "unresolved" | "collision" };
export type MailImportInspectionFailure = { kind: "unavailable" | "limit" };
export interface MailImportCandidate {
  id: string;
  blobId: string;
  size: number;
  messageId: string[] | null;
  keywords: Record<string, boolean>;
}
export interface MailImportSnapshot {
  state: string;
  candidates: Map<string, MailImportCandidate[]>;
}
export interface MailImportTools<
  Client,
  Session,
  Job,
  Inspection,
  Raw extends Uint8Array,
> {
  mailboxPatch(mailboxes: Record<string, boolean>): Record<string, boolean>;
  archiveMessages(
    raw: Raw,
    format: string,
    variant: string,
    onEnvelope?: (line: Raw) => void,
  ): AsyncIterable<Raw>;
  countArchive(
    raw: Raw,
    format: string,
    variant: string,
    labelCount: number,
  ): Promise<number>;
  migrationReport(job: Job): MailImportReport;
  messageMetadata(
    raw: Raw,
    mapping: Record<string, string>,
    destination: string,
    envelope?: Raw,
  ): Promise<MailImportMetadata>;
  prepareMigrationSnapshot(input: {
    client: Client;
    session: Session;
    accountId: string;
    archive: Raw;
    format: string;
    variant: string;
    keepAlive: () => Promise<boolean>;
  }): Promise<
    | { kind: "ready"; snapshot: MailImportSnapshot }
    | { kind: "failed"; error: MailImportInspectionFailure["kind"] }
  >;
  inspectMigrationCandidates(input: {
    client: Client;
    session: Session;
    accountId: string;
    bytes: Raw;
    messageId: string | null;
    marker?: string;
    snapshot?: MailImportSnapshot;
  }): Promise<Inspection>;
  resolveMigrationCandidate(input: {
    client: Client;
    session: Session;
    accountId: string;
    bytes: Raw;
    messageId: string | null;
    marker?: string;
    snapshot?: MailImportSnapshot;
    mailboxPatch: Record<string, boolean>;
    beforeMapping: () => Promise<boolean>;
  }): Promise<
    | { action: "import" | "stop" }
    | {
        action: "continue" | "stop";
        status: "failed" | "uncertain" | "duplicate" | "imported";
        error: string | null;
        id: string | null;
      }
  >;
  importMigrationMessage(input: {
    client: Client;
    session: Session;
    accountId: string;
    bytes: Raw;
    metadata: MailImportMetadata;
    marker: string;
    snapshot: MailImportSnapshot;
    beforeImport: () => Promise<boolean>;
    onImported: (id: string) => Promise<boolean>;
  }): Promise<
    | { kind: "recorded"; proceed: boolean }
    | { kind: "failed" | "uncertain"; error: string; proceed: boolean }
  >;
}

type ReportInput = {
  id: string;
  status: string;
  cancelRequested: boolean;
  error: string | null;
  total: number;
  items: { index: number; status: string; error: string | null }[];
};
export function migrationReport(job: ReportInput): MailImportReport {
  return MailImportReportSchema.parse({
    id: job.id,
    status: job.status,
    cancelRequested: job.cancelRequested,
    error: job.error,
    total: job.total,
    processed: job.items.filter((item) =>
      ["imported", "duplicate", "failed", "uncertain"].includes(item.status),
    ).length,
    messages: job.items.map((item) => ({
      index: item.index,
      status: item.status,
      error: item.error,
    })),
    limitations: MAIL_IMPORT_LIMITATIONS,
  });
}
