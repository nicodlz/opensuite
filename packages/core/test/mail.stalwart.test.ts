import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";
import { JmapClient } from "@opensuite/jmap";
import { StalwartAdmin } from "@opensuite/jmap/admin";
import { ok } from "neverthrow";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMailService } from "../src/services/mail.ts";

const run = promisify(execFile);
const project = `opensuite-mail-api-${randomBytes(6).toString("hex")}`;
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
      { cwd: new URL("../../../", import.meta.url), maxBuffer: 4_000_000 },
    )
  ).stdout;
const password = "cobalt-rocket-forest-9381!";
const actor = {
  id: "owner",
  email: "alice@example.test",
  role: "user",
} satisfies { id: string; email: string; role: "user" };
let base = "";
let service: ReturnType<typeof createMailService>;
const pause = async () =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, 500);
  });
const ready = async (attempts: number): Promise<void> => {
  try {
    if ((await fetch(`${base}/healthz/ready`)).ok) return;
  } catch {
    /* starting */
  }
  if (!attempts) throw new Error("Stalwart did not start");
  await pause();
  return ready(attempts - 1);
};
const localFetch: typeof fetch = async (input, init) => {
  const response = await fetch(input, init);
  const requestUrl = input instanceof Request ? input.url : input.toString();
  if (
    init?.method !== "POST" &&
    (requestUrl.endsWith("/.well-known/jmap") ||
      requestUrl.endsWith("/jmap/session")) &&
    response.ok
  ) {
    const data: unknown = await response.json();
    if (typeof data !== "object" || data === null)
      throw new Error("Bad session");
    const endpoints = Object.fromEntries(
      ["apiUrl", "uploadUrl", "downloadUrl"].map((key) => {
        const entry: unknown = Object.getOwnPropertyDescriptor(
          data,
          key,
        )?.value;
        if (typeof entry !== "string") throw new Error("Missing session URL");
        const original = new URL(entry);
        return [
          key,
          `${base}${original.pathname}${original.search}`
            .replaceAll("%7B", "{")
            .replaceAll("%7D", "}"),
        ];
      }),
    );
    return Response.json({ ...data, ...endpoints });
  }
  return response;
};
beforeAll(async () => {
  try {
    await compose("up", "-d");
    const port = (await compose("port", "stalwart", "8080"))
      .trim()
      .split(":")
      .at(-1);
    if (!port) throw new Error("Missing port");
    base = `http://127.0.0.1:${port}`;
    await ready(120);
    const admin = new StalwartAdmin(base, {
      username: "admin",
      password: "integration-password",
    });
    const domain = (await admin.createDomain("example.test")).match(
      (value) => value,
      (error) => {
        throw new Error(JSON.stringify(error));
      },
    );
    const alice = (
      await admin.createAccount("alice", domain.id, password)
    ).match(
      (value) => value,
      (error) => {
        throw new Error(JSON.stringify(error));
      },
    );
    (await admin.createAccount("bob", domain.id, password)).match(
      (value) => value,
      (error) => {
        throw new Error(JSON.stringify(error));
      },
    );
    const diagnostic = new JmapClient(base, {
      authorization: `Basic ${Buffer.from(`${actor.email}:${password}`).toString("base64")}`,
      fetch: localFetch,
    });
    const discovered = await diagnostic.discover();
    if (discovered.isErr())
      throw new Error(`Discovery: ${JSON.stringify(discovered.error)}`);
    const primary =
      discovered.value.primaryAccounts["urn:ietf:params:jmap:mail"];
    if (primary === undefined) throw new Error("Missing primary account");
    const mailboxResult = await diagnostic.mailboxes(discovered.value, primary);
    if (mailboxResult.isErr())
      throw new Error(`Mailboxes: ${JSON.stringify(mailboxResult.error)}`);
    service = createMailService({
      origin: base,
      store: {
        getForOwner: (userId, accountId) =>
          userId === actor.id && accountId === "default"
            ? Promise.resolve(
                ok({
                  accountId: alice.id,
                  address: actor.email,
                  secret: password,
                }),
              )
            : Promise.resolve(
                ok({
                  accountId: "different",
                  address: actor.email,
                  secret: password,
                }),
              ),
      },
      client: (credential) =>
        new JmapClient(base, {
          authorization: `Basic ${Buffer.from(`${credential.address}:${credential.secret}`).toString("base64")}`,
          fetch: localFetch,
        }),
    });
  } catch (error) {
    process.stderr.write(`Mail test setup failed: ${String(error)}\n`);
    await compose("down", "--volumes", "--remove-orphans").catch(
      () => undefined,
    );
    throw error;
  }
}, 120_000);
afterAll(async () => {
  await compose("down", "--volumes", "--remove-orphans");
}, 60_000);

describe("mail service with Stalwart", () => {
  it("uploads, persists and edits a draft, submits it, and reads the sent conversation", async () => {
    const boxes = (await service.mailboxes(actor, "default")).match(
      (value) => value,
      (error) => {
        throw new Error(JSON.stringify(error));
      },
    ).mailboxes;
    const sent = boxes.find((box) => box.role === "sent");
    expect(sent).toBeDefined();
    if (!sent) throw new Error("Missing sent mailbox");
    const upload = (
      await service.upload(actor, "default", {
        name: "note.txt",
        type: "text/plain",
        base64: Buffer.from("attachment").toString("base64"),
      })
    ).match(
      (value) => value,
      (error) => {
        throw new Error(JSON.stringify(error));
      },
    );
    expect(
      Buffer.from(
        (await service.download(actor, "default", upload.blobId)).match(
          (value) => value,
          (error) => {
            throw new Error(JSON.stringify(error));
          },
        ),
      ).toString(),
    ).toBe("attachment");
    const content = {
      to: [{ email: "bob@example.test" }],
      cc: [],
      bcc: [],
      subject: "Mail service test",
      textBody: "Hello Bob",
      htmlBody: "<p>Hello Bob</p>",
      attachmentBlobIds: [upload.blobId],
      references: [],
    };
    const created = (
      await service.createDraft(actor, "default", content)
    ).match(
      (value) => value,
      (error) => {
        throw new Error(JSON.stringify(error));
      },
    );
    expect(
      (await service.drafts(actor, "default"))
        .match(
          (value) => value,
          (error) => {
            throw new Error(JSON.stringify(error));
          },
        )
        .drafts.map((item) => item.id),
    ).toContain(created.id);
    const updated = (
      await service.updateDraft(actor, "default", created.id, {
        ...content,
        subject: "Updated subject",
      })
    ).match(
      (value) => value,
      (error) => {
        throw new Error(JSON.stringify(error));
      },
    );
    const output = (await service.send(actor, "default", updated.id)).match(
      (value) => value,
      (error) => {
        throw new Error(JSON.stringify(error));
      },
    );
    const thread = (
      await service.thread(actor, "default", output.threadId)
    ).match(
      (value) => value,
      (error) => {
        throw new Error(JSON.stringify(error));
      },
    );
    expect(thread.messages[0]).toMatchObject({
      subject: "Updated subject",
      textBody: "Hello Bob",
      htmlBody: "<p>Hello Bob</p>",
      attachments: [{ name: "note.txt" }],
    });
    const page = (
      await service.threads(actor, "default", {
        mailboxId: sent.id,
        limit: 10,
        sort: "newest",
      })
    ).match(
      (value) => value,
      (error) => {
        throw new Error(JSON.stringify(error));
      },
    );
    expect(page.threads.map((item) => item.id)).toContain(output.threadId);
    (
      await service.action(actor, "default", output.threadId, {
        type: "star",
        value: true,
      })
    ).match(
      (value) => value,
      (error) => {
        throw new Error(JSON.stringify(error));
      },
    );
    expect(
      (await service.thread(actor, "default", output.threadId)).match(
        (value) => value,
        (error) => {
          throw new Error(JSON.stringify(error));
        },
      ).messages[0]?.starred,
    ).toBe(true);
  }, 60_000);
});
