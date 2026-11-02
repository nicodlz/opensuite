import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, it } from "vitest";
import { z } from "zod";
import { JmapCapability, JmapClient } from "../src/index.ts";
import { StalwartAdmin } from "../src/admin.ts";

const run = promisify(execFile);
const project = `opensuite-schedule-probe-${randomBytes(6).toString("hex")}`;
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
const password = "cobalt-rocket-forest-9381!";
const pause = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
const value = <T>(result: {
  isErr(): boolean;
  value?: T;
  error?: unknown;
}): T => {
  if (result.isErr() || result.value === undefined)
    throw new Error(JSON.stringify(result.error));
  return result.value;
};
let base = "";
beforeAll(async () => {
  try {
    await compose("up", "-d");
    const port = (await compose("port", "stalwart", "8080"))
      .trim()
      .split(":")
      .at(-1);
    if (!port) throw new Error("Missing port");
    base = `http://127.0.0.1:${port}`;
    const ready = async (remaining: number): Promise<void> => {
      try {
        if ((await fetch(`${base}/healthz/ready`)).ok) return;
      } catch {
        /* starting */
      }
      if (!remaining) throw new Error("Stalwart did not start");
      await pause(500);
      return ready(remaining - 1);
    };
    await ready(120);
  } catch (error) {
    await compose("down", "--volumes", "--remove-orphans");
    throw error;
  }
}, 120_000);
afterAll(async () => {
  await compose("down", "--volumes", "--remove-orphans");
}, 60_000);

it("probes future release, cancellation, delivery, and draft updates on the pinned server", async () => {
  const admin = new StalwartAdmin(base, {
    username: "admin",
    password: "integration-password",
  });
  const domain = value(await admin.createDomain("example.test"));
  value(await admin.createAccount("alice", domain.id, password));
  value(await admin.createAccount("bob", domain.id, password));
  const authorization = (name: string) =>
    `Basic ${Buffer.from(`${name}@example.test:${password}`).toString("base64")}`;
  const client = (name: string) =>
    new JmapClient(base, {
      authorization: authorization(name),
      rewriteSessionUrlsToOrigin: base,
    });
  const alice = client("alice"),
    bob = client("bob");
  const session = value(await alice.discover()),
    bobSession = value(await bob.discover());
  const accountId = session.primaryAccounts[JmapCapability.mail],
    bobId = bobSession.primaryAccounts[JmapCapability.mail];
  if (!accountId || !bobId) throw new Error("Missing account");
  const capability = z
    .object({
      maxDelayedSend: z.number(),
      submissionExtensions: z.record(z.string(), z.unknown()),
    })
    .parse(
      session.accounts[accountId]?.accountCapabilities[
        JmapCapability.submission
      ],
    );
  expect(capability.maxDelayedSend).toBe(2_592_000);
  expect(capability.submissionExtensions).toHaveProperty("FUTURERELEASE");
  const boxes = value(await alice.mailboxes(session, accountId)).list;
  const drafts = boxes.find((box) => box.role === "drafts")?.id,
    sent = boxes.find((box) => box.role === "sent")?.id;
  const identity = value(await alice.identities(session, accountId)).list[0]
    ?.id;
  if (!drafts || !sent || !identity)
    throw new Error("Missing mailbox or identity");
  const call = async (method: string, args: object) => {
    const response = await fetch(session.apiUrl, {
      method: "POST",
      headers: {
        authorization: authorization("alice"),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        using: [
          JmapCapability.core,
          JmapCapability.mail,
          JmapCapability.submission,
        ],
        methodCalls: [[method, { accountId, ...args }, "x"]],
      }),
    });
    expect(response.ok).toBe(true);
    return z
      .object({
        methodResponses: z.array(
          z.tuple([z.string(), z.unknown(), z.string()]),
        ),
      })
      .parse(await response.json()).methodResponses;
  };
  const createDraft = async (subject: string) => {
    const blob = value(
      await alice.upload(
        session,
        accountId,
        Buffer.from(
          `From: alice@example.test\r\nTo: bob@example.test\r\nSubject: ${subject}\r\n\r\nTest\r\n`,
        ),
      ),
    );
    return value(
      await alice.importEmail(session, accountId, {
        blobId: blob.blobId,
        mailboxIds: { [drafts]: true },
        keywords: { $draft: true },
      }),
    ).id;
  };
  const submit = async (emailId: string, update: boolean) => {
    const responses = await call("EmailSubmission/set", {
      create: {
        item: {
          emailId,
          identityId: identity,
          envelope: {
            mailFrom: {
              email: "alice@example.test",
              parameters: { HOLDFOR: "8", ENVID: "schedule-probe-unique" },
            },
            rcptTo: [{ email: "bob@example.test" }],
          },
        },
      },
      ...(update
        ? {
            onSuccessUpdateEmail: {
              "#item": {
                mailboxIds: { [sent]: true },
                "keywords/$draft": null,
              },
            },
          }
        : {}),
    });
    const response = z
      .object({
        created: z.object({
          item: z.object({
            id: z.string(),
            sendAt: z.string(),
            undoStatus: z.string(),
          }),
        }),
      })
      .parse(responses[0]?.[1]);
    expect(response.created.item.undoStatus).toBe("pending");
    expect(Date.parse(response.created.item.sendAt)).toBeGreaterThan(
      Date.now() + 4000,
    );
    return { ...response.created.item, responses };
  };
  const canceledDraft = await createDraft("schedule-canceled");
  const canceled = await submit(canceledDraft, true);
  expect(canceled.responses[1]?.[0]).toBe("Email/set");
  const moved = value(await alice.emails(session, accountId, [canceledDraft]))
    .list[0];
  expect(moved?.mailboxIds).toEqual({ [sent]: true });
  expect(moved?.keywords["$draft"]).toBeUndefined();
  const cancellation = await call("EmailSubmission/set", {
    update: { [canceled.id]: { undoStatus: "canceled" } },
  });
  expect(cancellation[0]?.[1]).toMatchObject({
    updated: { [canceled.id]: null },
  });
  const check = await call("EmailSubmission/get", { ids: [canceled.id] });
  expect(check[0]?.[1]).toMatchObject({
    list: [
      {
        id: canceled.id,
        undoStatus: "canceled",
        envelope: {
          mailFrom: { parameters: { ENVID: "schedule-probe-unique" } },
        },
      },
    ],
  });
  const retainedDraft = await createDraft("schedule-released");
  const scheduled = await submit(retainedDraft, false);
  const retained = value(
    await alice.emails(session, accountId, [retainedDraft]),
  ).list[0];
  expect(retained?.mailboxIds).toEqual({ [drafts]: true });
  expect(retained?.keywords["$draft"]).toBe(true);
  expect(
    value(
      await bob.queryEmails(bobSession, bobId, {
        filter: { subject: "schedule-released" },
      }),
    ).ids,
  ).toEqual([]);
  await pause(Math.max(0, Date.parse(scheduled.sendAt) - Date.now()) + 4000);
  expect(
    value(
      await bob.queryEmails(bobSession, bobId, {
        filter: { subject: "schedule-released" },
      }),
    ).ids,
  ).toHaveLength(1);
  expect(
    value(
      await bob.queryEmails(bobSession, bobId, {
        filter: { subject: "schedule-canceled" },
      }),
    ).ids,
  ).toEqual([]);
}, 90_000);
