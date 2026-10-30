import { createReadinessService } from "@opensuite/core";
import { okAsync } from "neverthrow";
import { afterEach, expect, it } from "vitest";
import { upProbe, downProbe } from "../../../test-support/probes.ts";
import { PrismaClient } from "../src/db/generated/index.js";
import { createStorage } from "../src/adapters/storage.ts";
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
const readiness = createReadinessService({
  probes: [upProbe("database"), downProbe("object-storage", "secret")],
  timeoutMs: 100,
  now: () => new Date(),
  monotonicMs: () => performance.now(),
});
const app = buildServer(
  createDrive(database, storage, 1000),
  storage,
  { verify: () => okAsync(null) },
  readiness,
);
afterEach(async () => {
  await app.close();
  storage.close();
  await database.$disconnect();
});
it("keeps liveness up and exposes safe dependency status with a request ID", async () => {
  expect((await app.inject("/health")).statusCode).toBe(200);
  const result = await app.inject("/ready");
  expect(result.statusCode).toBe(503);
  expect(result.json()).toMatchObject({
    status: "not_ready",
    dependencies: [
      { name: "database", status: "up" },
      { name: "object-storage", status: "down" },
    ],
  });
  expect(result.headers["x-request-id"]).toBeDefined();
  expect(result.body).not.toContain("secret");
});
