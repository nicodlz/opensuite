import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { createReadinessService } from "@opensuite/core";
import { createMailService } from "@opensuite/core/services/mail";
import {
  createDatabase,
  createScheduledSendStore,
  type PrismaClient,
} from "@opensuite/db";
import { JmapClient } from "@opensuite/jmap";
import { StalwartAdmin } from "@opensuite/jmap/admin";
import { err, ok } from "neverthrow";
import { afterAll, beforeAll, expect, it } from "vitest";
import { buildServer } from "../src/server.ts";

const run = promisify(execFile);
const project = `opensuite-schedule-api-${randomBytes(6).toString("hex")}`;
const pg = `${project}-pg`;
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
const pause = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
const monotonic = () => performance.now();
const password = "cobalt-rocket-forest-9381!";
const actor = {
  id: "schedule-owner",
  email: "alice@example.test",
  role: "user" as const,
};
let base = "",
  accountId = "",
  db: PrismaClient | undefined;
const value = <T>(r: { isErr(): boolean; value?: T; error?: unknown }): T => {
  if (r.isErr() || r.value === undefined)
    throw new Error(JSON.stringify(r.error));
  return r.value;
};

beforeAll(async () => {
  try {
    await compose("up", "-d");
    const port = (await compose("port", "stalwart", "8080"))
      .trim()
      .split(":")
      .at(-1);
    if (!port) throw new Error("Missing Stalwart port");
    base = `http://127.0.0.1:${port}`;
    const ready = async (remaining: number): Promise<void> => {
      try {
        if ((await fetch(`${base}/healthz/ready`)).ok) return;
      } catch {
        /* starting */
      }
      if (!remaining) throw new Error("Stalwart unavailable");
      await pause(500);
      return ready(remaining - 1);
    };
    await ready(120);
    const admin = new StalwartAdmin(base, {
      username: "admin",
      password: "integration-password",
    });
    const domain = value(await admin.createDomain("example.test"));
    accountId = value(
      await admin.createAccount("alice", domain.id, password),
    ).id;
    value(await admin.createAccount("bob", domain.id, password));
    value(await admin.createAccount("blind", domain.id, password));
    value(await admin.createAlias(accountId, "alias", domain.id));
    await run("docker", [
      "run",
      "-d",
      "--name",
      pg,
      "-e",
      "POSTGRES_PASSWORD=test-password",
      "-e",
      "POSTGRES_INITDB_ARGS=--no-sync",
      "-p",
      "127.0.0.1::5432",
      "postgres:18.6",
    ]);
    const readyPg = async (remaining: number): Promise<void> => {
      try {
        await run("docker", ["exec", pg, "pg_isready", "-U", "postgres"]);
      } catch {
        if (!remaining) throw new Error("PostgreSQL unavailable");
        await pause(500);
        return readyPg(remaining - 1);
      }
    };
    await readyPg(120);
    const pgPort = /:(\d+)\s*$/.exec(
      (await run("docker", ["port", pg, "5432"])).stdout,
    )?.[1];
    if (!pgPort) throw new Error("Missing database port");
    const url = `postgresql://postgres:test-password@127.0.0.1:${pgPort}/postgres`;
    await run(
      "pnpm",
      ["--filter", "@opensuite/db", "exec", "prisma", "migrate", "deploy"],
      { env: { ...process.env, DATABASE_URL: url }, maxBuffer: 4_000_000 },
    );
    db = value(createDatabase(url));
    await db.user.create({
      data: { id: actor.id, email: actor.email, name: "Fixture" },
    });
  } catch (error) {
    await run("docker", ["rm", "-fv", pg]).catch(() => undefined);
    await compose("down", "--volumes", "--remove-orphans");
    throw error;
  }
}, 180_000);
afterAll(async () => {
  await db?.$disconnect();
  await run("docker", ["rm", "-fv", pg]).catch(() => undefined);
  await compose("down", "--volumes", "--remove-orphans");
}, 90_000);

it("persists, isolates, cancels, restarts, reconciles lost responses and releases mail", async () => {
  if (!db) throw new Error("Database unavailable");
  const database = db;
  let lostResponse: "create" | "cancel" | null = null;
  let clockOffset = 0;
  const fetchMaybeLose: typeof fetch = async (input, init) => {
    const response = await fetch(input, init);
    if (
      lostResponse &&
      typeof init?.body === "string" &&
      init.body.includes("EmailSubmission/set") &&
      (lostResponse === "create"
        ? init.body.includes("HOLDFOR")
        : init.body.includes("canceled"))
    ) {
      lostResponse = null;
      throw new Error("response lost after submission");
    }
    return response;
  };
  const credentials = {
    getForOwner: (userId: string, requested: string) =>
      Promise.resolve(
        userId === actor.id &&
          (requested === "default" || requested === accountId)
          ? ok({ accountId, address: actor.email, secret: password })
          : err({ kind: "not_found" }),
      ),
  };
  const createService = () =>
    createMailService({
      origin: base,
      now: () => Date.now() + clockOffset,
      store: credentials,
      scheduledStore: createScheduledSendStore(database),
      canSendAs: (_user, address) =>
        Promise.resolve(address === "alias@example.test" ? "alias" : null),
      beforeAliasSend: () => Promise.resolve(true),
      client: ({ address, secret }) =>
        new JmapClient(base, {
          authorization: `Basic ${Buffer.from(`${address}:${secret}`).toString("base64")}`,
          fetch: fetchMaybeLose,
          rewriteSessionUrlsToOrigin: base,
        }),
    });
  let mail = createService();
  const app = await buildServer({
    config: { logLevel: "silent" },
    monotonicMs: monotonic,
    readiness: createReadinessService({
      probes: [],
      timeoutMs: 500,
      now: () => new Date(),
      monotonicMs: monotonic,
    }),
    mail,
    identity: {
      publicOrigin: "https://suite.example.test",
      handler: () => Promise.resolve(new Response()),
      actor: (headers) =>
        Promise.resolve(
          headers.get("cookie") === "owner"
            ? actor
            : headers.get("cookie") === "other"
              ? { id: "other", email: "other@example.test", role: "user" }
              : null,
        ),
    },
  });
  const headers = { origin: "https://suite.example.test", cookie: "owner" };
  const attachmentBlobIds: string[] = [];
  const content = {
    from: "alias@example.test",
    to: [{ email: "bob@example.test" }],
    cc: [],
    bcc: [{ email: "blind@example.test" }],
    subject: "scheduled-api",
    textBody: "hello",
    htmlBody: "",
    attachmentBlobIds,
    references: [],
  };
  try {
    const upload = value(
      await mail.upload(actor, "default", {
        name: "file.txt",
        type: "text/plain",
        base64: Buffer.from("attachment").toString("base64"),
      }),
    );
    content.attachmentBlobIds.push(upload.blobId);
    const draft = value(await mail.createDraft(actor, "default", content));
    const requestId = randomUUID();
    const scheduled = await app.inject({
      method: "POST",
      url: "/mail/scheduled/create",
      headers,
      payload: {
        accountId: "default",
        draftId: draft.id,
        requestId,
        delivery: { type: "delay", seconds: 30 },
      },
    });
    expect(scheduled.statusCode).toBe(200);
    expect(scheduled.json()).toMatchObject({
      id: requestId,
      draftId: draft.id,
      state: "pending",
    });
    expect(
      value(
        await mail.schedule(actor, "default", draft.id, requestId, {
          type: "delay",
          seconds: 30,
        }),
      ).id,
    ).toBe(requestId);
    expect(
      (
        await mail.schedule(actor, "default", draft.id, requestId, {
          type: "delay",
          seconds: 31,
        })
      ).isErr(),
    ).toBe(true);
    expect(
      (await mail.updateDraft(actor, "default", draft.id, content)).isErr(),
    ).toBe(true);
    const anonymous = await app.inject({
      method: "POST",
      url: "/mail/scheduled/list",
      headers: { origin: headers.origin },
      payload: { accountId: "default" },
    });
    expect(anonymous.statusCode).toBe(401);
    const other = await app.inject({
      method: "POST",
      url: "/mail/scheduled/list",
      headers: { ...headers, cookie: "other" },
      payload: { accountId: "default" },
    });
    expect(other.statusCode).toBe(403);
    const canceled = await app.inject({
      method: "POST",
      url: "/mail/scheduled/cancel",
      headers,
      payload: { accountId: "default", id: requestId },
    });
    expect(canceled.statusCode).toBe(200);
    expect(canceled.json()).toMatchObject({
      state: "canceled",
      draftId: draft.id,
    });
    const edited = value(
      await mail.updateDraft(actor, "default", draft.id, {
        ...content,
        subject: "rescheduled-api",
      }),
    );
    const cancellationId = randomUUID();
    const another = value(
      await mail.schedule(actor, "default", edited.id, cancellationId, {
        type: "delay",
        seconds: 30,
      }),
    );
    expect(another.state).toBe("pending");
    lostResponse = "cancel";
    const cancellationUnknown = value(
      await mail.cancelScheduled(actor, "default", cancellationId),
    );
    expect(cancellationUnknown.state).toBe("unknown");
    expect(
      (await mail.updateDraft(actor, "default", edited.id, content)).isErr(),
    ).toBe(true);
    await mail.reconcileScheduled();
    expect(
      value(await mail.scheduled(actor, "default")).scheduled.find(
        (item) => item.id === cancellationId,
      )?.state,
    ).toBe("canceled");
    const editedAgain = value(
      await mail.updateDraft(actor, "default", edited.id, {
        ...content,
        subject: "rescheduled-api",
      }),
    );
    lostResponse = "create";
    const uncertain = value(
      await mail.schedule(actor, "default", editedAgain.id, randomUUID(), {
        type: "delay",
        seconds: 8,
      }),
    );
    expect(uncertain.state).toBe("unknown");
    mail = createService();
    await mail.reconcileScheduled();
    const found = value(await mail.scheduled(actor, "default")).scheduled.find(
      (item) => item.id === uncertain.id,
    );
    expect(found?.state).toBe("pending");
    await pause(
      Math.max(0, Date.parse(found?.releaseAt ?? "") - Date.now()) + 3000,
    );
    await mail.reconcileScheduled();
    const finished = value(
      await mail.scheduled(actor, "default"),
    ).scheduled.find((item) => item.id === uncertain.id);
    expect(finished?.state).toBe("sent");
    const blind = new JmapClient(base, {
      authorization: `Basic ${Buffer.from(`blind@example.test:${password}`).toString("base64")}`,
      rewriteSessionUrlsToOrigin: base,
    });
    const session = value(await blind.discover());
    const id = session.primaryAccounts["urn:ietf:params:jmap:mail"];
    if (!id) throw new Error("Missing blind recipient");
    const deliveries = value(
      await blind.queryEmails(session, id, {
        filter: { subject: "rescheduled-api" },
      }),
    ).ids;
    expect(deliveries).toHaveLength(1);
    const received = value(await blind.emails(session, id, deliveries)).list[0];
    expect(received?.from?.[0]?.email).toBe("alias@example.test");
    expect(received?.attachments).toHaveLength(1);
    const raceDraft = value(await mail.createDraft(actor, "default", content));
    const raceId = randomUUID();
    value(
      await mail.schedule(actor, "default", raceDraft.id, raceId, {
        type: "at",
        at: new Date(Date.now() + 30_000).toISOString(),
      }),
    );
    const [raceCancel, raceEdit] = await Promise.all([
      mail.cancelScheduled(actor, "default", raceId),
      mail.updateDraft(actor, "default", raceDraft.id, content),
    ]);
    expect(value(raceCancel).state).toBe("canceled");
    expect(raceEdit.isErr() || raceEdit.value.id !== raceDraft.id).toBe(true);
    const competingDraft = value(
      await mail.createDraft(actor, "default", content),
    );
    const [competingSchedule, competingEdit] = await Promise.all([
      mail.schedule(actor, "default", competingDraft.id, randomUUID(), {
        type: "delay",
        seconds: 30,
      }),
      mail.updateDraft(actor, "default", competingDraft.id, content),
    ]);
    expect(
      Number(competingSchedule.isOk()) + Number(competingEdit.isOk()),
    ).toBe(1);
    const lateDraft = value(await mail.createDraft(actor, "default", content));
    const lateId = randomUUID();
    value(
      await mail.schedule(actor, "default", lateDraft.id, lateId, {
        type: "delay",
        seconds: 30,
      }),
    );
    clockOffset = 31_000;
    expect(
      value(await mail.cancelScheduled(actor, "default", lateId)).state,
    ).toBe("releasing");
    clockOffset = 0;
    expect(
      (await mail.cancelScheduled(actor, "default", uncertain.id)).match(
        (v) => v.state,
        () => "error",
      ),
    ).toBe("sent");
  } finally {
    await app.close();
  }
}, 120_000);
