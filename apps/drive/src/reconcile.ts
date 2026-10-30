import { S3Client } from "@aws-sdk/client-s3";
import { readFile } from "node:fs/promises";
import process from "node:process";
import { z } from "zod";
import { PrismaClient } from "./db/generated/index.js";
import { reconcileObjects } from "./services/reconcile.ts";

const args = process.argv.slice(2);
if (
  args.some(
    (arg) => arg !== "--delete-old-staging" && arg !== "--delete-orphans",
  ) ||
  args.length > 1
) {
  process.stderr.write("Usage: node src/reconcile.ts [--delete-orphans]\n");
  process.exit(1);
}
const env = z
  .object({
    DRIVE_DATABASE_URL: z.string().min(1).optional(),
    DRIVE_DATABASE_PASSWORD_FILE: z.string().min(1).optional(),
    POSTGRES_DRIVE_DB: z.string().min(1).default("opensuite_drive"),
    DRIVE_S3_ENDPOINT: z.url(),
    DRIVE_S3_REGION: z.string().min(1),
    DRIVE_S3_BUCKET: z.string().min(3),
    DRIVE_S3_PREFIX: z.string().regex(/^(?:[a-zA-Z0-9_-]+\/)*$/),
    DRIVE_S3_ACCESS_KEY: z.string().min(1),
    DRIVE_S3_SECRET_KEY_FILE: z.string().min(1),
    DRIVE_S3_PATH_STYLE: z.enum(["true", "false"]).default("true"),
  })
  .parse(process.env);
let databaseUrl = env.DRIVE_DATABASE_URL;
if (
  databaseUrl === undefined &&
  env.DRIVE_DATABASE_PASSWORD_FILE !== undefined
) {
  const url = new URL("postgresql://postgres:5432/");
  url.username = "opensuite_drive";
  url.password = (
    await readFile(env.DRIVE_DATABASE_PASSWORD_FILE, "utf8")
  ).trim();
  url.pathname = `/${encodeURIComponent(env.POSTGRES_DRIVE_DB)}`;
  databaseUrl = url.toString();
}
if (databaseUrl === undefined)
  throw new Error("Drive database configuration missing");
const secret = (await readFile(env.DRIVE_S3_SECRET_KEY_FILE, "utf8")).trim();
if (!secret) throw new Error("Drive storage credential unavailable");
const db = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
const client = new S3Client({
  endpoint: env.DRIVE_S3_ENDPOINT,
  region: env.DRIVE_S3_REGION,
  credentials: {
    accessKeyId: env.DRIVE_S3_ACCESS_KEY,
    secretAccessKey: secret,
  },
  forcePathStyle: env.DRIVE_S3_PATH_STYLE === "true",
});
try {
  await reconcileObjects(
    db,
    client,
    {
      bucket: env.DRIVE_S3_BUCKET,
      prefix: env.DRIVE_S3_PREFIX,
      deleteStaging:
        args.includes("--delete-orphans") ||
        args.includes("--delete-old-staging"),
      now: new Date(),
    },
    (finding) => process.stdout.write(`${JSON.stringify(finding)}\n`),
  );
} finally {
  client.destroy();
  await db.$disconnect();
}
