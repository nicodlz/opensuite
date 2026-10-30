import { S3Client } from "@aws-sdk/client-s3";
import { SQSClient } from "@aws-sdk/client-sqs";
import {
  awsQueue,
  awsStorage,
  databaseLedger,
  IngestService,
  jmapDelivery,
  createReadinessService,
  httpProbe,
  bucketProbe,
  queueProbe,
} from "@opensuite/core";
import { readFile } from "node:fs/promises";
import {
  createDatabase,
  createDatabaseProbe,
  createDomainStore,
  createMailboxStore,
} from "@opensuite/db";
import { z } from "zod";
import { createHealthServer } from "./health.ts";
import { runWorker } from "./worker.ts";
import { operatorCommand } from "./operator.ts";

const route = z.object({ address: z.email(), destination: z.string().min(1) });
const destination = z.object({
  id: z.string().min(1),
  origin: z.url(),
  authorization: z.string().min(1),
  quarantineMailbox: z.string().min(1),
  rewriteSessionUrls: z.boolean().default(false),
});
const configSchema = z
  .object({
    DATABASE_URL: z.string().min(1),
    INBOUND_BUCKET: z.string().min(1),
    INBOUND_QUEUE_URL: z.url(),
    INBOUND_TOPIC_ARN: z.string().min(1),
    INBOUND_BUFFER_PREFIX: z.string().default(""),
    ARCHIVE_BUCKET: z.string().min(1),
    ARCHIVE_PREFIX: z.string().min(1).default("notifications/"),
    AWS_REGION: z.string().default("eu-north-1"),
    AWS_ENDPOINT_URL: z.url().optional(),
    ARCHIVE_ENDPOINT_URL: z.url().optional(),
    ARCHIVE_REGION: z.string().default("eu-north-1"),
    ARCHIVE_ACCESS_KEY_ID: z.string().optional(),
    ARCHIVE_SECRET_ACCESS_KEY: z.string().optional(),
    INGEST_ROUTES: z
      .string()
      .default("[]")
      .transform((s, ctx) => {
        try {
          return route.array().parse(JSON.parse(s));
        } catch {
          ctx.addIssue({ code: "custom", message: "Invalid routes JSON" });
          return z.NEVER;
        }
      }),
    INGEST_DESTINATIONS: z
      .string()
      .default("[]")
      .transform((s, ctx) => {
        try {
          return destination.array().parse(JSON.parse(s));
        } catch {
          ctx.addIssue({
            code: "custom",
            message: "Invalid destinations JSON",
          });
          return z.NEVER;
        }
      }),
    // Delivery to mailboxes linked in the database, without a restart.
    MAILBOX_KEY_FILE: z.string().min(1).optional(),
    INGEST_MAILBOX_ORIGIN: z.url().optional(),
    INGEST_HEALTH_PORT: z.coerce.number().int().min(1).max(65535).default(3002),
    INGEST_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(100).default(5),
    INGEST_AGE_SECONDS: z.coerce.number().int().min(1).default(3600),
    INGEST_HOLD_DAYS: z.coerce.number().int().min(1).max(365).default(14),
  })
  .superRefine((value, ctx) => {
    if (
      (value.ARCHIVE_ACCESS_KEY_ID === undefined) !==
      (value.ARCHIVE_SECRET_ACCESS_KEY === undefined)
    )
      ctx.addIssue({
        code: "custom",
        message: "Both archive credentials are required",
      });
    if (
      new Set(value.INGEST_ROUTES.map((r) => r.address.toLowerCase())).size !==
      value.INGEST_ROUTES.length
    )
      ctx.addIssue({ code: "custom", message: "Duplicate route address" });
    if (
      new Set(value.INGEST_DESTINATIONS.map((d) => d.id)).size !==
      value.INGEST_DESTINATIONS.length
    )
      ctx.addIssue({ code: "custom", message: "Duplicate destination" });
    const linked = value.MAILBOX_KEY_FILE !== undefined;
    if (linked !== (value.INGEST_MAILBOX_ORIGIN !== undefined))
      ctx.addIssue({
        code: "custom",
        message: "MAILBOX_KEY_FILE and INGEST_MAILBOX_ORIGIN go together",
      });
    if (!linked && value.INGEST_DESTINATIONS.length === 0)
      ctx.addIssue({ code: "custom", message: "No destination" });
    if (
      value.INGEST_ROUTES.some(
        (r) => !value.INGEST_DESTINATIONS.some((d) => d.id === r.destination),
      )
    )
      ctx.addIssue({ code: "custom", message: "Route has no destination" });
    if (
      value.INBOUND_BUCKET === value.ARCHIVE_BUCKET &&
      value.ARCHIVE_ENDPOINT_URL === value.AWS_ENDPOINT_URL &&
      (value.INBOUND_BUFFER_PREFIX === "" ||
        value.ARCHIVE_PREFIX.startsWith(value.INBOUND_BUFFER_PREFIX) ||
        value.INBOUND_BUFFER_PREFIX.startsWith(value.ARCHIVE_PREFIX))
    )
      ctx.addIssue({
        code: "custom",
        message: "Buffer and archive prefixes overlap",
      });
  });
const config = configSchema.safeParse(process.env);
if (!config.success) {
  process.stderr.write(
    `${JSON.stringify({ level: "fatal", event: "invalid_configuration", fields: config.error.issues.map((issue) => issue.path.join(".")) })}\n`,
  );
  process.exit(1);
}
const c = config.data;
const db = createDatabase(c.DATABASE_URL);
if (db.isErr()) {
  process.stderr.write(
    `${JSON.stringify({ level: "fatal", event: "invalid_database_configuration" })}\n`,
  );
  process.exit(1);
}
function fatal(event: string): never {
  process.stderr.write(`${JSON.stringify({ level: "fatal", event })}\n`);
  process.exit(1);
}
/**
 * Stored mailbox credentials, checked at start by decrypting one: a key that
 * differs from the API's would otherwise only fail deliveries.
 */
async function linkedMailboxes() {
  if (c.MAILBOX_KEY_FILE === undefined || c.INGEST_MAILBOX_ORIGIN === undefined)
    return undefined;
  const key = await readFile(c.MAILBOX_KEY_FILE, "utf8").catch(() => null);
  if (key === null) return fatal("mailbox_key_unavailable");
  if (db.isErr()) return fatal("invalid_database_configuration");
  const store = createMailboxStore(db.value, key.trim());
  if (store.isErr()) return fatal("invalid_mailbox_key");
  const sample = await db.value.mailboxLink.findFirst({
    where: { status: "active", user: { disabled: false } },
    select: { accountId: true },
  });
  if (sample !== null) {
    const opened = await store.value.getForAccount(sample.accountId);
    if (opened.isErr())
      return fatal(
        opened.error.kind === "database_error"
          ? "mailbox_key_check_failed"
          : "invalid_mailbox_key",
      );
  }
  return {
    origin: c.INGEST_MAILBOX_ORIGIN,
    credential: async (accountId: string) =>
      store.value.getForAccount(accountId),
  };
}
const s3 = new S3Client({
  requestHandler: {
    connectionTimeout: 10_000,
    requestTimeout: 120_000,
    throwOnRequestTimeout: true,
  },
  region: c.AWS_REGION,
  ...(c.AWS_ENDPOINT_URL === undefined ? {} : { endpoint: c.AWS_ENDPOINT_URL }),
  forcePathStyle: c.AWS_ENDPOINT_URL !== undefined,
});
const sqs = new SQSClient({
  requestHandler: {
    connectionTimeout: 10_000,
    requestTimeout: 120_000,
    throwOnRequestTimeout: true,
  },
  region: c.AWS_REGION,
  ...(c.AWS_ENDPOINT_URL === undefined ? {} : { endpoint: c.AWS_ENDPOINT_URL }),
});
const archive = new S3Client({
  requestHandler: {
    connectionTimeout: 10_000,
    requestTimeout: 120_000,
    throwOnRequestTimeout: true,
  },
  region: c.ARCHIVE_REGION,
  ...(c.ARCHIVE_ENDPOINT_URL === undefined
    ? {}
    : { endpoint: c.ARCHIVE_ENDPOINT_URL }),
  forcePathStyle: c.ARCHIVE_ENDPOINT_URL !== undefined,
  ...(c.ARCHIVE_ACCESS_KEY_ID !== undefined &&
  c.ARCHIVE_SECRET_ACCESS_KEY !== undefined
    ? {
        credentials: {
          accessKeyId: c.ARCHIVE_ACCESS_KEY_ID,
          secretAccessKey: c.ARCHIVE_SECRET_ACCESS_KEY,
        },
      }
    : {}),
});
const counters = new Map<string, number>();
const ledger = databaseLedger(db.value);
const storage = awsStorage(
  s3,
  archive,
  c.INBOUND_BUCKET,
  c.ARCHIVE_BUCKET,
  c.ARCHIVE_PREFIX,
  c.INBOUND_BUFFER_PREFIX,
);
const mailboxes = await linkedMailboxes();
const delivery = jmapDelivery(c.INGEST_DESTINATIONS, mailboxes);
const service = new IngestService({
  storage,
  ledger,
  delivery,
  routes: c.INGEST_ROUTES,
  resolveRoutes: async (addresses) => {
    const result = await createDomainStore(db.value).routes(addresses);
    return result;
  },
  bucket: c.INBOUND_BUCKET,
  bufferPrefix: c.INBOUND_BUFFER_PREFIX,
  topic: c.INBOUND_TOPIC_ARN,
  maxAttempts: c.INGEST_MAX_ATTEMPTS,
  holdDays: c.INGEST_HOLD_DAYS,
  events: {
    emit(event, fields) {
      const count = (counters.get(event) ?? 0) + 1;
      counters.set(event, count);
      const safe = {
        stage: fields["stage"],
        attempts: fields["attempts"],
        delaySeconds: fields["delaySeconds"],
        matches: fields["matches"],
        recipientKey: fields["recipientKey"],
      };
      process.stdout.write(
        `${JSON.stringify({ level: event === "ingest_duplicate" ? "error" : "info", event, count, ...safe })}\n`,
      );
    },
  },
});
const queue = awsQueue(sqs, c.INBOUND_QUEUE_URL);
const command = process.argv[2] ?? "worker";
const readiness = createReadinessService({
  probes: [
    createDatabaseProbe(db.value),
    queueProbe(sqs, c.INBOUND_QUEUE_URL),
    bucketProbe("buffer-storage", s3, c.INBOUND_BUCKET),
    bucketProbe("archive-storage", archive, c.ARCHIVE_BUCKET),
    ...[
      ...c.INGEST_DESTINATIONS.map((target) => target.origin),
      ...(mailboxes === undefined ? [] : [mailboxes.origin]),
    ].map((target, index) =>
      httpProbe(
        `mail-server-${String(index + 1)}`,
        new URL("/healthz/ready", target).toString(),
      ),
    ),
  ],
  timeoutMs: 2000,
  now: () => new Date(),
  monotonicMs: () => performance.now(),
});
let healthServer: ReturnType<typeof createHealthServer> | undefined;
try {
  if (command === "replay") {
    const reset = await ledger.resetFailures();
    if (reset.isErr()) throw new Error("replay reset failed");
    const result = await service.reconcile(c.INGEST_AGE_SECONDS);
    if (result.isErr()) {
      process.stderr.write(
        `${JSON.stringify({ level: "error", event: "replay_failed" })}\n`,
      );
      process.exitCode = 1;
    }
  } else if (command === "operator") {
    const result = await operatorCommand(
      { db: db.value, ledger, delivery, storage },
      process.argv.slice(3),
    );
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else if (command === "worker") {
    const state = { stopping: false };
    healthServer = createHealthServer(readiness, () => state.stopping);
    await new Promise<void>((resolve) =>
      healthServer?.listen(c.INGEST_HEALTH_PORT, "0.0.0.0", resolve),
    );
    const stop = new AbortController();
    const shutdown = () => {
      state.stopping = true;
      stop.abort();
    };
    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
    try {
      await runWorker(
        queue,
        (item) => service.handle(queue, item),
        stop.signal,
        () => {
          process.stderr.write(
            `${JSON.stringify({ level: "error", event: "ingest_failure", stage: "queue" })}\n`,
          );
        },
      );
    } finally {
      process.off("SIGTERM", shutdown);
      process.off("SIGINT", shutdown);
    }
  } else {
    process.stderr.write(
      `${JSON.stringify({ level: "error", event: "unknown_command" })}\n`,
    );
    process.exitCode = 2;
  }
} finally {
  if (healthServer !== undefined)
    await new Promise<void>((resolve, reject) =>
      healthServer?.close((error) =>
        error === undefined ? resolve() : reject(error),
      ),
    );
  await db.value.$disconnect();
  s3.destroy();
  archive.destroy();
  sqs.destroy();
}
