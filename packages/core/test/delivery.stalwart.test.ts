import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";
import { JmapCapability, JmapClient } from "@opensuite/jmap";
import { StalwartAdmin } from "@opensuite/jmap/admin";
import { afterAll, beforeAll, expect, it } from "vitest";
import { jmapDelivery } from "../src/adapters/jmap.ts";
import type { Result } from "neverthrow";

const run = promisify(execFile);
const project = `opensuite-ingest-jmap-${randomBytes(6).toString("hex")}`;
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
      { cwd: new URL("../../../", import.meta.url) },
    )
  ).stdout;
const unwrap = <T, E>(result: Result<T, E>): T => {
  if (result.isErr()) throw new Error(JSON.stringify(result.error));
  return result.value;
};
const password = "cobalt-rocket-forest-9381!";
let origin: string;
let quarantine: string;
let client: JmapClient;

beforeAll(async () => {
  try {
    await compose("up", "-d");
    const port = (await compose("port", "stalwart", "8080"))
      .trim()
      .split(":")
      .at(-1);
    if (port === undefined) throw new Error("Missing port");
    origin = `http://127.0.0.1:${port}`;
    const ready = async (attempt: number): Promise<void> => {
      try {
        if ((await fetch(`${origin}/healthz/ready`)).ok) return;
      } catch {
        /* startup */
      }
      if (attempt >= 120) throw new Error("Stalwart did not become ready");
      await new Promise((resolve) => setTimeout(resolve, 500));
      return ready(attempt + 1);
    };
    await ready(0);
    const admin = new StalwartAdmin(origin, {
      username: "admin",
      password: "integration-password",
    });
    const domain = unwrap(await admin.createDomain("example.test"));
    unwrap(await admin.createAccount("alice", domain.id, password));
    client = new JmapClient(origin, {
      authorization: `Basic ${Buffer.from(`alice@example.test:${password}`).toString("base64")}`,
      rewriteSessionUrlsToOrigin: origin,
    });
    const session = unwrap(await client.discover());
    const account = session.primaryAccounts[JmapCapability.mail];
    if (account === undefined) throw new Error("Missing account");
    const box = unwrap(await client.mailboxes(session, account)).list.find(
      (item) => item.role === "junk",
    );
    if (box === undefined) throw new Error("Missing quarantine mailbox");
    quarantine = box.id;
  } catch (error) {
    await compose("down", "--volumes", "--remove-orphans");
    throw error;
  }
}, 120_000);
afterAll(async () => {
  await compose("down", "--volumes", "--remove-orphans");
}, 60_000);

it("confirms an imported message using keyword, date, Message-ID and bytes", async () => {
  const delivery = jmapDelivery([
    {
      id: "alice",
      origin,
      authorization: `Basic ${Buffer.from(`alice@example.test:${password}`).toString("base64")}`,
      quarantineMailbox: quarantine,
      rewriteSessionUrls: true,
    },
  ]);
  const bytes = Buffer.from(
    "Message-ID: <test@example.test>\r\nFrom: sender@example.test\r\nTo: alice@example.test\r\nSubject: Recovery\r\n\r\nHello\r\n",
  );
  const date = "2026-01-02T03:04:05.321Z";
  const key = "a".repeat(64);
  const imported = unwrap(
    await delivery.import("alice", bytes, false, date, key, new Map()),
  );
  expect(
    unwrap(await delivery.reconcile("alice", bytes, false, date, key)),
  ).toBe(imported);
  expect(
    (
      await delivery.reconcile(
        "alice",
        Buffer.from("different"),
        false,
        date,
        key,
      )
    ).isErr(),
  ).toBe(true);
  expect(
    (
      await delivery.reconcile("alice", bytes, false, date, "b".repeat(64))
    ).isErr(),
  ).toBe(true);
  const session = unwrap(await client.discover());
  const account = session.primaryAccounts[JmapCapability.mail];
  if (account === undefined) throw new Error("Missing account");
  const email = unwrap(await client.emails(session, account, [imported]))
    .list[0];
  expect(email?.receivedAt).toBe("2026-01-02T03:04:05Z");
}, 60_000);
