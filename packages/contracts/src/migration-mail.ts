import { oc } from "@orpc/contract";
import { z } from "zod";
import { IdSchema } from "./mail.ts";

export const MAIL_ARCHIVE_LIMIT = 8 * 1024 * 1024;
export const MAIL_MESSAGE_LIMIT = 4 * 1024 * 1024;
export const MAIL_IMPORT_DESTINATION_CHANGED =
  "A destination mailbox changed or was removed. Choose destinations again to resume.";
export const MAIL_IMPORT_OVER_QUOTA =
  "Mailbox quota exceeded. Free space and resume the import.";
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
const abandonWarning =
  "Some uncertain messages may already be in your mailbox. Abandoning removes the stored archive and import progress; it never deletes delivered mail.";
export const MailImportReportSchema = z.object({
  id: IdSchema,
  status: z.enum(["queued", "running", "completed", "cancelled", "attention"]),
  cancelRequested: z.boolean(),
  error: z.string().nullable(),
  total: z.number().int().nonnegative(),
  processed: z.number().int().nonnegative(),
  messages: z.array(entry),
  limitations: z.array(z.string()),
  recovery: z
    .object({ action: z.enum(["remap", "resume"]), message: z.string() })
    .nullable(),
  abandonment: z
    .object({
      uncertainCount: z.number().int().positive(),
      warning: z.literal(abandonWarning),
    })
    .nullable(),
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
  remap: procedure
    .route({ method: "POST", path: "/mail/imports/remap" })
    .input(
      jobInput.extend({
        mailboxId: IdSchema,
        labels: z.record(z.string().min(1).max(200), IdSchema),
      }),
    )
    .output(MailImportReportSchema),
  abandon: procedure
    .route({ method: "POST", path: "/mail/imports/abandon" })
    .input(
      jobInput.extend({
        confirm: z.literal(true),
        uncertainCount: z.number().int().positive().max(1000),
      }),
    )
    .output(z.object({ abandoned: z.literal(true) })),
};
export type MailImportInput = z.infer<typeof MailImportInputSchema>;
export type MailImportReport = z.infer<typeof MailImportReportSchema>;

export interface MailImportMetadata {
  messageId: string | null;
  mailboxIds: Record<string, boolean>;
  keywords: Record<string, boolean>;
  receivedAt?: string;
}
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
export interface MailImportTools<Client, Session, Job, Raw extends Uint8Array> {
  captureMigrationDestinations(input: {
    client: Client;
    session: Session;
    accountId: string;
    ids: readonly string[];
  }): Promise<
    | { kind: "retry" }
    | { kind: "changed" }
    | {
        kind: "ready";
        names: Record<string, { name: string; parentId: string | null }>;
      }
  >;
  checkMigrationDestinations(input: {
    client: Client;
    session: Session;
    accountId: string;
    ids: readonly string[];
    expected: unknown;
  }): Promise<{ kind: "retry" | "changed" | "ready" }>;
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
    ids: readonly string[];
    expected: unknown;
    keepAlive: () => Promise<boolean>;
  }): Promise<
    | { kind: "ready"; snapshot: MailImportSnapshot }
    | {
        kind: "failed";
        error: MailImportInspectionFailure["kind"] | "destination";
      }
  >;
  runMigrationItem(input: {
    client: Client;
    session: Session;
    accountId: string;
    raw: Raw;
    envelope?: Raw | undefined;
    status: string;
    marker: string;
    mapping: Record<string, string>;
    destination: string;
    snapshot: MailImportSnapshot | undefined;
    snapshotError: string;
    metadata: MailImportTools<Client, Session, Job, Raw>["messageMetadata"];
    mailboxPatch: MailImportTools<Client, Session, Job, Raw>["mailboxPatch"];
    importMessage: MailImportTools<
      Client,
      Session,
      Job,
      Raw
    >["importMigrationMessage"];
    record: (
      status: string,
      error: string | null,
      id: string | null,
    ) => Promise<boolean>;
    beforeImport: () => Promise<boolean>;
    keepAlive: () => Promise<boolean>;
    expected: unknown;
    onChanged: () => Promise<unknown>;
  }): Promise<boolean>;
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
    | { kind: "retry"; proceed: false }
    | { kind: "failed" | "uncertain"; error: string; proceed: boolean }
  >;
}

type ReportInput = {
  id: string;
  status: string;
  cancelRequested: boolean;
  error: string | null;
  total: number;
  archive: string | null;
  claimToken: string | null;
  items: { index: number; status: string; error: string | null }[];
};
export function migrationReport(job: ReportInput): MailImportReport {
  const uncertainCount = job.items.filter((item) =>
    ["uncertain", "importing"].includes(item.status),
  ).length;
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
    recovery:
      job.status !== "attention" ||
      job.archive === null ||
      job.claimToken !== null
        ? null
        : job.error === MAIL_IMPORT_DESTINATION_CHANGED
          ? { action: "remap", message: MAIL_IMPORT_DESTINATION_CHANGED }
          : job.items.some((item) => item.error === MAIL_IMPORT_OVER_QUOTA)
            ? { action: "resume", message: MAIL_IMPORT_OVER_QUOTA }
            : null,
    abandonment:
      job.status === "attention" &&
      job.claimToken === null &&
      job.archive !== null &&
      uncertainCount > 0
        ? { uncertainCount, warning: abandonWarning }
        : null,
  });
}
