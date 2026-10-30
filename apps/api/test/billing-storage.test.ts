/* oxlint-disable typescript/consistent-type-assertions, typescript/no-unsafe-type-assertion */
import { once } from "node:events";
import { createServer } from "node:http";
import { okAsync } from "neverthrow";
import { expect, it } from "vitest";
import type { PrismaClient } from "@opensuite/db";
import type { StalwartAdmin } from "@opensuite/jmap/admin";
import type { Entitlements } from "../src/billing/entitlements.ts";
import { createStorageMeter } from "../src/billing/storage.ts";

it("combines actual Drive and mail usage and sends a one-byte limit when exhausted", async () => {
  const server = createServer((request, reply) => {
    if (request.headers.authorization !== "Bearer local-token") {
      reply.writeHead(401).end();
      return;
    }
    reply
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ driveBytes: 600 }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    if (address === null || typeof address === "string")
      throw new Error("missing listener");
    let quota: number | null = null;
    let limit: number | null | undefined;
    const db = {
      mailboxLink: {
        findUnique: () =>
          Promise.resolve({ accountId: "account", status: "active" }),
      },
    } as unknown as PrismaClient;
    const mail = {
      diskUsage: () => okAsync(30),
      setDiskQuota: (_id: string, value: number | null) => {
        limit = value;
        return okAsync(undefined);
      },
    } as unknown as StalwartAdmin;
    const entitlements = {
      get: () => Promise.resolve({ quotaBytes: quota }),
    } as unknown as Entitlements;
    const storage = createStorageMeter(
      db,
      entitlements,
      mail,
      `http://127.0.0.1:${address.port}`,
      "local-token",
    );
    expect(await storage.measure("owner")).toEqual({
      driveBytes: 600,
      mailBytes: 30,
      usedBytes: 630,
      measured: true,
    });
    quota = 500;
    await storage.refresh("owner");
    expect(limit).toBe(1);
    quota = 1000;
    await storage.refresh("owner");
    expect(limit).toBe(400);
    quota = null;
    await storage.refresh("owner");
    expect(limit).toBeNull();
    const unavailable = createStorageMeter(
      db,
      entitlements,
      mail,
      `http://127.0.0.1:${address.port}`,
      undefined,
    );
    expect(await unavailable.measure("owner")).toMatchObject({
      driveBytes: 0,
      mailBytes: 30,
      measured: false,
    });
    quota = 0;
    await unavailable.refresh("owner");
    expect(limit).toBe(1);
  } finally {
    server.close();
    await once(server, "close");
  }
});

it("coalesces refresh requests and skips unchanged quotas", async () => {
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let reads = 0;
  let writes = 0;
  const db = {
    mailboxLink: {
      findUnique: () =>
        Promise.resolve({ accountId: "mail", status: "active" }),
    },
  } as unknown as PrismaClient;
  const mail = {
    setDiskQuota: () => {
      writes++;
      return okAsync(undefined);
    },
  } as unknown as StalwartAdmin;
  const entitlements = {
    get: async () => {
      reads++;
      if (reads === 1) await gate;
      return { quotaBytes: null };
    },
  } as unknown as Entitlements;
  const storage = createStorageMeter(
    db,
    entitlements,
    mail,
    "http://127.0.0.1",
    undefined,
  );
  const first = storage.refresh("owner");
  const second = storage.refresh("owner");
  const third = storage.refresh("owner");
  finish();
  await Promise.all([first, second, third]);
  expect(reads).toBe(2);
  expect(writes).toBe(1);
  await storage.refresh("owner");
  expect(writes).toBe(1);
});
