import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { z } from "zod";
import { StalwartAdmin } from "../src/admin.ts";
import { JmapCapability, JmapClient } from "../src/index.ts";

const run = promisify(execFile);
const project = `esuno-quota-${randomBytes(6).toString("hex")}`;
const compose = async (...args: string[]) =>
  (
    await run(
      "docker",
      [
        "compose",
        "-p",
        project,
        "-f",
        "deploy/stalwart/compose.stalwart-test.yaml",
        ...args,
      ],
      {
        cwd: new URL("../../../", import.meta.url),
        maxBuffer: 4_000_000,
      },
    )
  ).stdout;
const response = z.object({
  methodResponses: z.array(z.tuple([z.string(), z.unknown(), z.string()])),
});
const accountResponse = z.object({
  list: z.array(
    z.object({
      usedDiskQuota: z.number(),
      quotas: z.record(z.string(), z.number()),
    }),
  ),
});
const quotaResponse = z.object({
  list: z.array(
    z.object({
      resourceType: z.string(),
      used: z.number(),
      hardLimit: z.number().nullable(),
    }),
  ),
});
const pause = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

it("reports a configured account disk quota and rejects an over-quota mail import", async () => {
  try {
    await compose("up", "-d");
    const port = (await compose("port", "stalwart", "8080"))
      .trim()
      .split(":")
      .at(-1);
    if (!port) throw new Error("No fixture port");
    const base = `http://127.0.0.1:${port}`;
    const ready = async (remaining: number): Promise<void> => {
      try {
        if ((await fetch(`${base}/healthz/ready`)).ok) return;
      } catch {
        /* startup */
      }
      if (!remaining) throw new Error("Stalwart unavailable");
      await pause(500);
      await ready(remaining - 1);
    };
    await ready(120);
    const admin = new StalwartAdmin(base, {
      username: "admin",
      password: "integration-password",
    });
    const domain = await admin.createDomain("quota.test");
    if (domain.isErr()) throw new Error("domain creation failed");
    const account = await admin.createAccount(
      "alice",
      domain.value.id,
      "test-password-12345",
    );
    if (account.isErr()) throw new Error("account creation failed");
    const id = account.value.id;
    const call = async (
      method: string,
      input: object,
      capabilities: string[],
    ) => {
      const result = await fetch(`${base}/jmap/`, {
        method: "POST",
        headers: {
          authorization: `Basic ${Buffer.from("admin:integration-password").toString("base64")}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          using: capabilities,
          methodCalls: [[method, input, "a"]],
        }),
      });
      expect(result.ok).toBe(true);
      const parsed = response.parse(await result.json());
      expect(parsed.methodResponses[0]?.[0]).toBe(method);
      return parsed.methodResponses[0]?.[1];
    };
    const management = [JmapCapability.core, JmapCapability.management];
    const updated = z
      .object({ updated: z.record(z.string(), z.unknown()) })
      .parse(
        await call(
          "x:Account/set",
          { update: { [id]: { "quotas/maxDiskQuota": 100 } } },
          management,
        ),
      );
    expect(Object.hasOwn(updated.updated, id)).toBe(true);
    const found = accountResponse.parse(
      await call("x:Account/get", { ids: [id] }, management),
    );
    expect(found.list[0]).toMatchObject({
      usedDiskQuota: 0,
      quotas: { maxDiskQuota: 100 },
    });
    const quota = quotaResponse.parse(
      await call("Quota/get", { accountId: id }, [
        JmapCapability.core,
        "urn:ietf:params:jmap:quota",
      ]),
    );
    expect(quota.list).toContainEqual(
      expect.objectContaining({
        resourceType: "octets",
        used: 0,
        hardLimit: 100,
      }),
    );
    const client = new JmapClient(base, {
      authorization: `Basic ${Buffer.from("alice@quota.test:test-password-12345").toString("base64")}`,
    });
    const discovered = await client.discover();
    if (discovered.isErr()) throw new Error("discovery failed");
    const rewrite = (url: string) =>
      `${base}${new URL(url).pathname}${new URL(url).search}`
        .replaceAll("%7B", "{")
        .replaceAll("%7D", "}");
    const session = {
      ...discovered.value,
      apiUrl: rewrite(discovered.value.apiUrl),
      uploadUrl: rewrite(discovered.value.uploadUrl),
      downloadUrl: rewrite(discovered.value.downloadUrl),
    };
    const accountId = session.primaryAccounts[JmapCapability.mail];
    if (!accountId) throw new Error("No mail account");
    const mailboxes = await client.mailboxes(session, accountId);
    if (mailboxes.isErr()) throw new Error("mailboxes unavailable");
    const inbox = mailboxes.value.list.find((box) => box.role === "inbox");
    if (!inbox) throw new Error("No inbox");
    const blob = await client.upload(
      session,
      accountId,
      Buffer.from(
        `From: a@quota.test\r\nTo: alice@quota.test\r\nSubject: test\r\n\r\n${"x".repeat(1000)}`,
      ),
    );
    if (blob.isErr()) throw new Error("upload failed");
    const imported = await client.importEmail(session, accountId, {
      blobId: blob.value.blobId,
      mailboxIds: { [inbox.id]: true },
    });
    expect(imported.isErr() && imported.error).toMatchObject({
      kind: "set",
      type: "overQuota",
    });
    await call(
      "x:Account/set",
      { update: { [id]: { "quotas/maxDiskQuota": 0 } } },
      management,
    );
    const unlimited = quotaResponse.parse(
      await call("Quota/get", { accountId: id }, [
        JmapCapability.core,
        "urn:ietf:params:jmap:quota",
      ]),
    );
    expect(unlimited.list).toEqual([]);
    const accepted = await client.importEmail(session, accountId, {
      blobId: blob.value.blobId,
      mailboxIds: { [inbox.id]: true },
    });
    expect(accepted.isOk()).toBe(true);
    const after = accountResponse.parse(
      await call("x:Account/get", { ids: [id] }, management),
    );
    expect(after.list[0]?.usedDiskQuota).toBeGreaterThan(100);
    expect((await admin.setDiskQuota(id, 1)).isOk()).toBe(true);
    const reading = await client.download(
      session,
      accountId,
      blob.value.blobId,
      "existing.eml",
      "message/rfc822",
    );
    expect(reading.isOk() && reading.value.length).toBeGreaterThan(100);
    const another = await client.upload(
      session,
      accountId,
      Buffer.from(
        "From: a@quota.test\r\nTo: alice@quota.test\r\nSubject: another\r\n\r\nNew mail",
      ),
    );
    if (another.isErr()) throw new Error("upload failed");
    const refused = await client.importEmail(session, accountId, {
      blobId: another.value.blobId,
      mailboxIds: { [inbox.id]: true },
    });
    expect(refused.isErr() && refused.error).toMatchObject({
      kind: "set",
      type: "overQuota",
    });
    expect((await admin.diskUsage(id)).isOk()).toBe(true);
    expect((await admin.setDiskQuota(id, null)).isOk()).toBe(true);
    const removed = quotaResponse.parse(
      await call("Quota/get", { accountId: id }, [
        JmapCapability.core,
        "urn:ietf:params:jmap:quota",
      ]),
    );
    expect(removed.list).toEqual([]);
  } finally {
    await compose("down", "--volumes", "--remove-orphans");
  }
}, 180_000);
