import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { z } from "zod";
import type { Result } from "neverthrow";
import { StalwartAdmin } from "../src/admin.ts";
import {
  JmapCapability,
  JmapClient,
  type JmapError,
  type Session,
} from "../src/index.ts";

const run = promisify(execFile);
const value = <T>(result: Result<T, JmapError>): T => {
  if (result.isErr()) throw new Error(JSON.stringify(result.error));
  return result.value;
};
const delay = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

test("routes authenticated external mail to the relay and keeps local mail local", async () => {
  const directory = await mkdtemp(join(tmpdir(), "outbound-"));
  await chmod(directory, 0o755);
  const secret = join(directory, "secret");
  await writeFile(secret, "fixture-secret", { mode: 0o644 });
  const project = `outbound-${randomBytes(6).toString("hex")}`;
  const root = new URL("../../../", import.meta.url).pathname;
  const overlay = join(directory, "compose.yaml");
  await writeFile(
    overlay,
    `services:\n  stalwart:\n    volumes:\n      - "${secret}:/run/opensuite/smtp-secret:ro"\n  relay:\n    image: node:24.22.2-trixie-slim@sha256:54f84b4cf8432b21aaffd5d3ce8d41e12cea0d10d33c09d2f3c9879d49d6b446\n    command: ["node", "/fixture/smtp-relay.ts"]\n    volumes:\n      - "${root}test-support/smtp-relay.ts:/fixture/smtp-relay.ts:ro"\n    ports:\n      - "127.0.0.1::8081"\n`,
  );
  const compose = async (...args: string[]) =>
    (
      await run(
        "docker",
        [
          "compose",
          "-p",
          project,
          "-f",
          `${root}deploy/stalwart/compose.stalwart-test.yaml`,
          "-f",
          overlay,
          ...args,
        ],
        { maxBuffer: 4_000_000 },
      )
    ).stdout;
  try {
    await compose("up", "-d");
    const relayPort = (await compose("port", "relay", "8081"))
      .trim()
      .split(":")
      .at(-1);
    if (!relayPort) throw new Error("No relay capture port");
    const readMessages = async () =>
      z
        .array(
          z.object({
            from: z.string(),
            to: z.array(z.string()),
            authenticated: z.boolean(),
            data: z.string(),
          }),
        )
        .parse(await (await fetch(`http://127.0.0.1:${relayPort}/`)).json());
    const port = (await compose("port", "stalwart", "8080"))
      .trim()
      .split(":")
      .at(-1);
    const base = `http://127.0.0.1:${port}`;
    const waitReady = async (remaining: number): Promise<void> => {
      try {
        if ((await fetch(`${base}/healthz/ready`)).ok) return;
      } catch {
        /* starting */
      }
      if (remaining === 0) throw new Error("Stalwart not ready");
      await delay(500);
      return waitReady(remaining - 1);
    };
    await waitReady(120);
    const admin = new StalwartAdmin(base, {
      username: "admin",
      password: "integration-password",
    });
    const stageData = async () => {
      const response = await fetch(`${base}/jmap/`, {
        method: "POST",
        headers: {
          authorization: `Basic ${Buffer.from("admin:integration-password").toString("base64")}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          using: ["urn:ietf:params:jmap:core", "urn:stalwart:jmap"],
          methodCalls: [["x:MtaStageData/get", { ids: ["singleton"] }, "0"]],
        }),
      });
      const stage = z
        .object({
          methodResponses: z.tuple([
            z.tuple([
              z.string(),
              z.object({
                list: z.tuple([z.record(z.string(), z.unknown())]),
              }),
              z.string(),
            ]),
          ]),
        })
        .parse(await response.json());
      return stage.methodResponses[0][1].list[0];
    };
    const domain = value(await admin.createDomain("outbound.test"));
    value(
      await admin.createAccount("alice", domain.id, "fixture-password-123"),
    );
    value(await admin.createAccount("bob", domain.id, "fixture-password-123"));
    const records = value(await admin.dkimRecords(domain.id));
    expect(records.length).toBeGreaterThan(0);
    expect(records[0]?.type).toBe("TXT");
    expect(records[0]?.name).toContain("._domainkey.outbound.test");
    expect(records[0]?.value).toContain("v=DKIM1;");
    const config = {
      host: "relay",
      port: 2525,
      username: "fixture-user",
      secretFile: "/run/opensuite/smtp-secret",
      tls: "insecure",
    };
    const initialStage = await stageData();
    value(await admin.configureRelay(config));
    value(await admin.configureRelay(config));
    expect((await stageData())["dkimSignDomain"]).toEqual({
      match: {},
      else: "false",
    });
    const makeClient = (name: string) =>
      new JmapClient(base, {
        authorization: `Basic ${Buffer.from(`${name}@outbound.test:fixture-password-123`).toString("base64")}`,
      });
    const alice = makeClient("alice");
    const bob = makeClient("bob");
    const rewrite = (url: string) =>
      `${base}${new URL(url).pathname}${new URL(url).search}`
        .replaceAll("%7B", "{")
        .replaceAll("%7D", "}");
    const session = async (client: JmapClient): Promise<Session> => {
      const data = value(await client.discover());
      return {
        ...data,
        apiUrl: rewrite(data.apiUrl),
        uploadUrl: rewrite(data.uploadUrl),
        downloadUrl: rewrite(data.downloadUrl),
      };
    };
    const aliceSession = await session(alice);
    const bobSession = await session(bob);
    const aliceId = aliceSession.primaryAccounts[JmapCapability.mail];
    const bobId = bobSession.primaryAccounts[JmapCapability.mail];
    if (!aliceId || !bobId) throw new Error("Missing accounts");
    const boxes = value(await alice.mailboxes(aliceSession, aliceId)).list;
    const drafts = boxes.find((box) => box.role === "drafts");
    const identity = value(
      await alice.identities(aliceSession, aliceId),
    ).list.find((item) => item.email === "alice@outbound.test");
    if (!drafts || !identity)
      throw new Error("Missing draft mailbox or identity");
    const send = async (to: string, subject: string) => {
      const raw = Buffer.from(
        `From: alice@outbound.test\r\nTo: ${to}\r\nSubject: ${subject}\r\n\r\nFixture\r\n`,
      );
      const blob = value(await alice.upload(aliceSession, aliceId, raw));
      const email = value(
        await alice.importEmail(aliceSession, aliceId, {
          blobId: blob.blobId,
          mailboxIds: { [drafts.id]: true },
          keywords: { $draft: true },
        }),
      );
      value(
        await alice.submit(aliceSession, aliceId, email.id, identity.id, {
          mailFrom: { email: "alice@outbound.test" },
          rcptTo: [{ email: to }],
        }),
      );
    };
    await send("external@example.com", "External fixture");
    await send("bob@outbound.test", "Local fixture");
    const waitRelay = async (remaining: number): Promise<void> => {
      if ((await readMessages()).length > 0) return;
      if (remaining === 0) throw new Error("No relay delivery");
      await delay(500);
      return waitRelay(remaining - 1);
    };
    await waitRelay(60);
    const messages = await readMessages();
    expect(messages).toHaveLength(1);
    expect(messages[0]?.authenticated).toBe(true);
    expect(messages[0]?.from).toMatch(/alice@outbound\.test/i);
    expect(messages[0]?.to).toHaveLength(1);
    expect(messages[0]?.to[0]).toMatch(/external@example\.com/i);
    expect(messages[0]?.data).toContain("External fixture");
    // The relay signs: Stalwart must not add a DKIM signature of its own.
    expect(messages[0]?.data).not.toMatch(/^DKIM-Signature:/im);
    const waitLocal = async (remaining: number): Promise<string[]> => {
      const ids = value(
        await bob.queryEmails(bobSession, bobId, {
          filter: { subject: "Local fixture" },
        }),
      ).ids;
      if (ids.length > 0) return ids;
      if (remaining === 0) throw new Error("No local delivery");
      await delay(500);
      return waitLocal(remaining - 1);
    };
    expect((await waitLocal(60)).length).toBeGreaterThan(0);
    await delay(1000);
    expect(await readMessages()).toHaveLength(1);
    value(await admin.configureRelay({ ...config, tls: "starttls" }));
    value(await admin.resetOutbound());
    // Reset restores Stalwart's own default signing and leaves every other
    // stage setting as it was.
    expect(await stageData()).toEqual(initialStage);
  } finally {
    try {
      await compose("down", "--volumes", "--remove-orphans");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}, 120_000);
