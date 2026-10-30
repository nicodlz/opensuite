import { readFile } from "node:fs/promises";
import process from "node:process";
import { PrismaClient } from "./db/generated/index.js";
import { createStorage } from "./adapters/storage.ts";
import { httpSessionVerifier } from "./adapters/session.ts";
import { loadConfig } from "./config.ts";
import { createDrive } from "./services/drive.ts";
import { buildServer } from "./server.ts";

const env = { ...process.env };
if (
  env["DRIVE_DATABASE_URL"] === undefined &&
  env["POSTGRES_PASSWORD_FILE"] !== undefined
) {
  const password = (
    await readFile(env["POSTGRES_PASSWORD_FILE"], "utf8")
  ).trim();
  const url = new URL("postgresql://postgres:5432/");
  url.username = env["POSTGRES_USER"] ?? "opensuite";
  url.password = password;
  url.pathname = `/${encodeURIComponent(env["POSTGRES_DRIVE_DB"] ?? "opensuite_drive")}`;
  env["DRIVE_DATABASE_URL"] = url.toString();
}
const result = loadConfig(env);
if (result.isErr()) {
  process.stderr.write(
    `${JSON.stringify({ message: "invalid Drive configuration", issues: result.error.issues })}\n`,
  );
  process.exit(1);
}
const config = result.value;
const db = new PrismaClient({
  datasources: { db: { url: config.DRIVE_DATABASE_URL } },
});
const storage = createStorage({
  endpoint: config.DRIVE_S3_ENDPOINT,
  publicEndpoint: config.DRIVE_S3_PUBLIC_ENDPOINT,
  region: config.DRIVE_S3_REGION,
  bucket: config.DRIVE_S3_BUCKET,
  prefix: config.DRIVE_S3_PREFIX,
  accessKeyId: config.DRIVE_S3_ACCESS_KEY,
  secretAccessKey: config.DRIVE_S3_SECRET_KEY,
  forcePathStyle: config.DRIVE_S3_PATH_STYLE === "true",
});
const app = buildServer(
  createDrive(db, storage, config.DRIVE_QUOTA_BYTES),
  storage,
  httpSessionVerifier(config.DRIVE_SESSION_API),
);
app.addHook("onClose", async () => {
  storage.close();
  await db.$disconnect();
});
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => {
    void app.close();
  });
await app.listen({ host: config.DRIVE_HOST, port: config.DRIVE_PORT });
