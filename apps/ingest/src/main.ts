import { S3Client } from "@aws-sdk/client-s3";
import { SQSClient } from "@aws-sdk/client-sqs";
import {
  awsQueue,
  awsStorage,
  databaseLedger,
  IngestService,
  jmapDelivery,
} from "@opensuite/core";
import { createDatabase } from "@opensuite/db";
import { z } from "zod";

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
    INGEST_ROUTES: z.string().transform((s, ctx) => {
      try {
        return route.array().parse(JSON.parse(s));
      } catch {
        ctx.addIssue({ code: "custom", message: "Invalid routes JSON" });
        return z.NEVER;
      }
    }),
    INGEST_DESTINATIONS: z.string().transform((s, ctx) => {
      try {
        return destination.array().parse(JSON.parse(s));
      } catch {
        ctx.addIssue({ code: "custom", message: "Invalid destinations JSON" });
        return z.NEVER;
      }
    }),
    INGEST_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(100).default(5),
    INGEST_AGE_SECONDS: z.coerce.number().int().min(1).default(3600),
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
  process.stderr.write(`Invalid configuration: ${config.error.message}\n`);
  process.exit(1);
}
const c = config.data;
const db = createDatabase(c.DATABASE_URL);
if (db.isErr()) {
  process.stderr.write(`${db.error.message}\n`);
  process.exit(1);
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
const service = new IngestService({
  storage: awsStorage(
    s3,
    archive,
    c.INBOUND_BUCKET,
    c.ARCHIVE_BUCKET,
    c.ARCHIVE_PREFIX,
    c.INBOUND_BUFFER_PREFIX,
  ),
  ledger,
  delivery: jmapDelivery(c.INGEST_DESTINATIONS),
  routes: c.INGEST_ROUTES,
  bucket: c.INBOUND_BUCKET,
  bufferPrefix: c.INBOUND_BUFFER_PREFIX,
  topic: c.INBOUND_TOPIC_ARN,
  maxAttempts: c.INGEST_MAX_ATTEMPTS,
  events: {
    emit(event, fields) {
      const count = (counters.get(event) ?? 0) + 1;
      counters.set(event, count);
      process.stdout.write(`${JSON.stringify({ event, count, ...fields })}\n`);
    },
  },
});
const queue = awsQueue(sqs, c.INBOUND_QUEUE_URL);
const command = process.argv[2] ?? "worker";
try {
  if (command === "replay") {
    const reset = await ledger.resetFailures();
    if (reset.isErr()) throw new Error(reset.error.message);
    const result = await service.reconcile(c.INGEST_AGE_SECONDS);
    if (result.isErr()) {
      process.stderr.write(`${result.error.message}\n`);
      process.exitCode = 1;
    }
  } else if (command === "worker") {
    const state = { stopping: false };
    process.on("SIGTERM", () => {
      state.stopping = true;
    });
    process.on("SIGINT", () => {
      state.stopping = true;
    });
    const pollOnce = async (): Promise<boolean> => {
      const received = await queue.receive();
      if (received.isErr()) {
        process.stderr.write(
          `${JSON.stringify({ event: "ingest_failure", stage: "queue", message: received.error.message })}\n`,
        );
        await new Promise((resolve) => setTimeout(resolve, 5000));
        return false;
      }
      await Promise.all(
        received.value.map((item) => service.handle(queue, item)),
      );
      return true;
    };
    async function* polls(): AsyncGenerator<boolean> {
      while (!state.stopping) yield pollOnce();
    }
    for await (const result of polls()) {
      if (!result) continue;
    }
  } else {
    process.stderr.write("Usage: node src/main.ts [worker|replay]\n");
    process.exitCode = 2;
  }
} finally {
  await db.value.$disconnect();
  s3.destroy();
  archive.destroy();
  sqs.destroy();
}
