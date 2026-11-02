import { z } from "zod";
import { IdSchema } from "./mail.ts";
import {
  MailImportReportSchema,
  MailImportAccountSchema,
  MailImportJobSchema,
  mailImportProcedure,
  MailImportListEntrySchema,
  MailImportAbandonSchema,
  MailImportAbandonedSchema,
} from "./migration-mail.ts";

export const DirectMigrationInputSchema = z.object({
  accountId: IdSchema,
  mailboxId: IdSchema,
  labels: z.record(z.string().min(1).max(1024), IdSchema).default({}),
  source: z.union([
    z.object({
      kind: z.literal("gmail"),
      username: z.string().min(1).max(320),
      password: z.string().min(1).max(1024),
      oauthAccessToken: z.never().optional(),
    }),
    z.object({
      kind: z.literal("gmail"),
      username: z.string().min(1).max(320),
      oauthAccessToken: z.string().min(1).max(4096),
      password: z.never().optional(),
    }),
    z.object({
      kind: z.literal("imap"),
      host: z.string().min(1).max(253),
      port: z.number().int().min(1).max(65535).default(993),
      username: z.string().min(1).max(320),
      password: z.string().min(1).max(1024),
    }),
  ]),
});
export type DirectMigrationInput = z.infer<typeof DirectMigrationInputSchema>;
export const DIRECT_ABANDON_WARNING =
  "Some uncertain messages may already be in your mailbox. Abandoning removes progress and stored source data, but never deletes delivered mail.";
export const DIRECT_SOURCE_LIMIT = "direct_source_limit";
export const DirectMigrationReportSchema = MailImportReportSchema.omit({
  abandonment: true,
  recovery: true,
}).extend({
  recovery: z
    .object({ action: z.enum(["resume", "cancel"]), message: z.string() })
    .nullable(),
  abandonment: z
    .object({
      uncertainCount: z.number().int().positive(),
      warning: z.literal(DIRECT_ABANDON_WARNING),
    })
    .nullable(),
  source: z.enum(["gmail", "imap"]),
  inventoryReady: z.boolean(),
});
const account = MailImportAccountSchema;
const job = MailImportJobSchema;
const procedure = mailImportProcedure;
export const migrationDirectContract = {
  create: procedure
    .route({ method: "POST", path: "/mail/direct-imports/create" })
    .input(DirectMigrationInputSchema)
    .output(DirectMigrationReportSchema),
  list: procedure
    .route({ method: "POST", path: "/mail/direct-imports/list" })
    .input(account)
    .output(
      z.object({
        jobs: z.array(
          MailImportListEntrySchema.extend({
            source: z.enum(["gmail", "imap"]),
          }),
        ),
      }),
    ),
  report: procedure
    .route({ method: "POST", path: "/mail/direct-imports/report" })
    .input(job)
    .output(DirectMigrationReportSchema),
  cancel: procedure
    .route({ method: "POST", path: "/mail/direct-imports/cancel" })
    .input(job)
    .output(DirectMigrationReportSchema),
  revoke: procedure
    .route({ method: "POST", path: "/mail/direct-imports/revoke" })
    .input(job)
    .output(z.object({ revoked: z.literal(true) })),
  abandon: procedure
    .route({ method: "POST", path: "/mail/direct-imports/abandon" })
    .input(MailImportAbandonSchema)
    .output(MailImportAbandonedSchema),
  resume: procedure
    .route({ method: "POST", path: "/mail/direct-imports/resume" })
    .input(job.extend({ password: z.string().min(1).max(4096).optional() }))
    .output(DirectMigrationReportSchema),
};

export const DirectSourceSchema = z.object({
  kind: z.enum(["gmail", "imap"]),
  host: z.string().min(1).max(253),
  port: z.number().int().min(1).max(65535),
  username: z.string().min(1).max(320),
  password: z.string().min(1).max(4096),
  authKind: z.enum(["password", "oauth"]).default("password"),
});
export const DirectSourceRefSchema = z.object({
  mailbox: z.string().min(1).max(1024),
  validity: z.string().regex(/^\d+$/),
  uid: z.number().int().positive(),
  size: z.number().int().nonnegative(),
  labels: z.array(z.string().max(1024)).max(200),
  flags: z.array(z.string().max(200)).max(100),
  date: z.iso.datetime().nullable(),
  emailId: z.string().max(1024).nullable(),
});
export type DirectSource = z.infer<typeof DirectSourceSchema>;
export type DirectSourceRef = z.infer<typeof DirectSourceRefSchema>;
export interface DirectConnection {
  inventory(): Promise<DirectSourceRef[]>;
  read(ref: DirectSourceRef): Promise<Uint8Array>;
  close(): void;
}
export type DirectConnector = (
  source: DirectSource,
) => Promise<DirectConnection>;
