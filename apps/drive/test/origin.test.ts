import { okAsync } from "neverthrow";
import { afterAll, expect, it } from "vitest";
import { PrismaClient } from "../src/db/generated/index.js";
import { createStorage } from "../src/adapters/storage.ts";
import { loadConfig } from "../src/config.ts";
import { createDrive } from "../src/services/drive.ts";
import { buildServer } from "../src/server.ts";

const storage = createStorage({
  endpoint: "http://127.0.0.1:1",
  publicEndpoint: "http://127.0.0.1:1",
  region: "test",
  bucket: "test",
  prefix: "",
  accessKeyId: "fake",
  secretAccessKey: "fake",
  forcePathStyle: true,
});
const database = new PrismaClient({
  datasources: { db: { url: "postgresql://test:test@127.0.0.1:1/test" } },
});
const app = buildServer(
  createDrive(database, storage, 1000),
  storage,
  { verify: () => okAsync(null) },
  undefined,
  ["https://drive.example.test", "https://mail.example.test"],
);
afterAll(async () => {
  await app.close();
  storage.close();
  await database.$disconnect();
});

it("refuses writes from origins outside the application list", async () => {
  const refused = await Promise.all(
    [undefined, "https://other.example.test", "null"].map((origin) =>
      app.inject({
        method: "POST",
        url: "/v1/folders",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          ...(origin === undefined ? {} : { origin }),
        },
        payload: "name=x",
      }),
    ),
  );
  expect(refused.map((response) => response.statusCode)).toEqual([
    403, 403, 403,
  ]);
  const allowed = await app.inject({
    method: "POST",
    url: "/v1/folders",
    headers: {
      origin: "https://drive.example.test",
      "content-type": "application/json",
    },
    payload: "{}",
  });
  expect(allowed.statusCode).not.toBe(403);
  expect((await app.inject("/health")).statusCode).toBe(200);
});

it("requires exact trusted origins in the configuration", () => {
  const base = {
    DRIVE_DATABASE_URL: "postgresql://u:p@db/drive",
    DRIVE_SESSION_API: "http://api:3000",
    DRIVE_S3_ENDPOINT: "http://s3",
    DRIVE_S3_PUBLIC_ENDPOINT: "https://s3.example.test",
    DRIVE_S3_REGION: "r",
    DRIVE_S3_BUCKET: "bucket",
    DRIVE_S3_PREFIX: "drive/",
    DRIVE_S3_ACCESS_KEY: "a",
    DRIVE_S3_SECRET_KEY: "s",
  };
  expect(loadConfig(base).isErr()).toBe(true);
  for (const value of [
    "https://drive.example.test/path",
    "https://*.example.test",
  ])
    expect(loadConfig({ ...base, DRIVE_TRUSTED_ORIGINS: value }).isErr()).toBe(
      true,
    );
  const parsed = loadConfig({
    ...base,
    DRIVE_TRUSTED_ORIGINS:
      "https://drive.example.test, https://mail.example.test",
  });
  expect(parsed.isOk() && parsed.value.DRIVE_TRUSTED_ORIGINS).toEqual([
    "https://drive.example.test",
    "https://mail.example.test",
  ]);
  expect(parsed.isOk() && parsed.value.DRIVE_QUOTA_BYTES).toBeUndefined();
  const limited = loadConfig({
    ...base,
    DRIVE_TRUSTED_ORIGINS: "https://drive.example.test",
    DRIVE_QUOTA_BYTES: "42",
  });
  expect(limited.isOk() && limited.value.DRIVE_QUOTA_BYTES).toBe(42);
});
