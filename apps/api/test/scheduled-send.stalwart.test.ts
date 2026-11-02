import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { RecoveredDraftSchema } from "@opensuite/contracts";
import { createReadinessService } from "@opensuite/core";
import { createMailService } from "@opensuite/core/services/mail";
import { createGuards } from "@opensuite/core/adapters/scheduled-send";
import { createDatabase, type PrismaClient } from "@opensuite/db";
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
  let lostResponse:
    | "create"
    | "cancel"
    | "read"
    | "editCreate"
    | "editDelete"
    | "flag"
    | "send"
    | "missingSend"
    | "missingCreate"
    | "move"
    | "delayedMove"
    | "fenceRead"
    | "fenceWrite"
    | null = null;
  let clockOffset = 0;
  let submissionAttempts = 0;
  let immediateAttempts = 0;
  let delayedMove: (() => Promise<Response>) | undefined;
  const fetchMaybeLose: typeof fetch = async (input, init) => {
    const body = typeof init?.body === "string" ? init.body : "";
    const guardedMove =
      body.includes('"Email/set"') &&
      body.includes('"mailboxIds"') &&
      body.includes('"ifInState"');
    if (body.includes("HOLDFOR")) submissionAttempts++;
    if (body.includes('"EmailSubmission/set"') && !body.includes("HOLDFOR"))
      immediateAttempts++;
    if (lostResponse === "missingCreate" && body.includes("HOLDFOR")) {
      lostResponse = null;
      throw new Error("submission request lost");
    }
    if (lostResponse === "delayedMove" && guardedMove) {
      lostResponse = null;
      delayedMove = () => fetch(input, { ...init, signal: null });
      throw new Error("mutation request delayed");
    }
    if (lostResponse === "fenceRead" && body.includes('"Email/get"')) {
      lostResponse = null;
      throw new Error("mutation reconciliation unavailable");
    }
    if (
      lostResponse === "missingSend" &&
      body.includes('"EmailSubmission/set"') &&
      !body.includes("HOLDFOR")
    ) {
      lostResponse = null;
      throw new Error("immediate submission request lost");
    }
    const response = await fetch(input, init);
    if (
      (lostResponse === "read" && body.includes('"Mailbox/get"')) ||
      (lostResponse === "editCreate" &&
        body.includes('"Email/set"') &&
        body.includes('"create"')) ||
      (lostResponse === "editDelete" &&
        body.includes('"Email/set"') &&
        body.includes('"destroy"')) ||
      (lostResponse === "flag" &&
        body.includes('"Email/set"') &&
        body.includes("keywords/$seen")) ||
      (lostResponse === "move" && guardedMove) ||
      (lostResponse === "fenceWrite" &&
        body.includes("keywords/opensuite_guard_")) ||
      (lostResponse === "send" &&
        body.includes('"EmailSubmission/set"') &&
        !body.includes("HOLDFOR")) ||
      (lostResponse === "create" && body.includes("HOLDFOR")) ||
      (lostResponse === "cancel" && body.includes("canceled"))
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
      ...createGuards(database),
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
    const ownerClient = new JmapClient(base, {
      authorization: `Basic ${Buffer.from(`${actor.email}:${password}`).toString("base64")}`,
      rewriteSessionUrlsToOrigin: base,
    });
    const ownerSession = value(await ownerClient.discover());
    let ownerBoxes = value(
      await ownerClient.mailboxes(ownerSession, accountId),
    ).list;
    if (!ownerBoxes.some((item) => item.role === "archive")) {
      const response = await fetch(ownerSession.apiUrl, {
        method: "POST",
        headers: {
          authorization: `Basic ${Buffer.from(`${actor.email}:${password}`).toString("base64")}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"],
          methodCalls: [
            [
              "Mailbox/set",
              {
                accountId,
                create: { archive: { name: "Archive", role: "archive" } },
              },
              "0",
            ],
          ],
        }),
      });
      if (!response.ok || !(await response.text()).includes('"created"'))
        throw new Error("Could not create archive mailbox");
      ownerBoxes = value(
        await ownerClient.mailboxes(ownerSession, accountId),
      ).list;
    }
    const boxId = (role: string) => {
      const box = ownerBoxes.find((item) => item.role === role);
      if (!box) throw new Error(`Missing ${role} mailbox`);
      return box.id;
    };
    const ownerEmail = async (draftId: string) => {
      const result = value(
        await ownerClient.emails(ownerSession, accountId, [draftId]),
      );
      const email = result.list.find((item) => item.id === draftId);
      if (!email) throw new Error("Missing draft");
      return { email, state: result.state };
    };
    const actions = [
      {
        action: { type: "move", mailboxId: boxId("inbox") },
        destination: boxId("inbox"),
      },
      { action: { type: "archive" }, destination: boxId("archive") },
      { action: { type: "trash" }, destination: boxId("trash") },
    ] as const;
    await actions.reduce<Promise<void>>(
      (previous, { action, destination }) =>
        previous.then(async () => {
          const moving = value(
            await mail.createDraft(actor, "default", content),
          );
          const { email: initial } = await ownerEmail(moving.id);
          lostResponse = "move";
          expect(
            (
              await mail.action(actor, "default", initial.threadId, action, [
                moving.id,
              ])
            ).isErr(),
          ).toBe(true);
          const guard = await database.mailDraftGuard.findUniqueOrThrow({
            where: {
              userId_accountId_draftId: {
                userId: actor.id,
                accountId,
                draftId: moving.id,
              },
            },
          });
          expect(guard.phase).toBe("mutation");
          expect(guard.mutationState).toBeTruthy();
          const blockedMove = await mail.action(
            actor,
            "default",
            initial.threadId,
            { type: "move", mailboxId: boxId("drafts") },
            [moving.id],
          );
          expect(blockedMove.isErr() ? blockedMove.error.kind : undefined).toBe(
            "conflict",
          );
          await expect(
            database.$executeRaw`UPDATE "MailDraftGuard" SET "mutationState" = NULL WHERE "token" = ${guard.token}`,
          ).rejects.toThrow(/MailDraftGuard_mutation_state_check/);
          expect(
            (await ownerEmail(moving.id)).email.mailboxIds[destination],
          ).toBe(true);
          const copied = await app.inject({
            method: "POST",
            url: "/mail/drafts/recover-copy",
            headers,
            payload: {
              accountId: "default",
              draftId: moving.id,
              acknowledgeOriginalMayStillSend: true,
            },
          });
          expect(copied.statusCode).toBe(200);
          const copy = RecoveredDraftSchema.parse(copied.json());
          expect(copy.draft.bcc).toEqual(content.bcc);
          expect(copy.draft.attachmentBlobIds).toHaveLength(1);
          expect(
            (
              await mail.updateDraft(
                actor,
                "default",
                copy.draft.id,
                copy.draft,
              )
            ).isOk(),
          ).toBe(true);
          clockOffset = 301_000;
          mail = createService();
          lostResponse = "fenceRead";
          await expect(mail.reconcileScheduled()).rejects.toThrow(
            "scheduled reconciliation incomplete",
          );
          expect(
            value(await mail.draftGuardStatus(actor, "default", moving.id))
              .state,
          ).toBe("unknown");
          clockOffset = 602_000;
          await mail.reconcileScheduled();
          expect(
            value(await mail.draftGuardStatus(actor, "default", moving.id))
              .state,
          ).toBe("clear");
          expect(
            (await ownerEmail(moving.id)).email.mailboxIds[destination],
          ).toBe(true);
          clockOffset = 0;
          expect(
            (
              await mail.action(
                actor,
                "default",
                initial.threadId,
                { type: "move", mailboxId: boxId("drafts") },
                [moving.id],
              )
            ).isOk(),
          ).toBe(true);
          expect(
            (
              await mail.updateDraft(actor, "default", moving.id, content)
            ).isOk(),
          ).toBe(true);
          return undefined;
        }),
      Promise.resolve(),
    );

    const delayed = value(await mail.createDraft(actor, "default", content));
    const { email: delayedEmail } = await ownerEmail(delayed.id);
    lostResponse = "delayedMove";
    expect(
      (
        await mail.action(
          actor,
          "default",
          delayedEmail.threadId,
          { type: "trash" },
          [delayed.id],
        )
      ).isErr(),
    ).toBe(true);
    const delayedGuard = await database.mailDraftGuard.findUniqueOrThrow({
      where: {
        userId_accountId_draftId: {
          userId: actor.id,
          accountId,
          draftId: delayed.id,
        },
      },
    });
    clockOffset = 301_000;
    mail = createService();
    lostResponse = "fenceWrite";
    await expect(mail.reconcileScheduled()).rejects.toThrow(
      "scheduled reconciliation incomplete",
    );
    expect(
      Object.keys((await ownerEmail(delayed.id)).email.keywords).some((key) =>
        key.startsWith("opensuite_guard_"),
      ),
    ).toBe(true);
    expect(
      value(await mail.draftGuardStatus(actor, "default", delayed.id)).state,
    ).toBe("unknown");
    clockOffset = 602_000;
    mail = createService();
    await mail.reconcileScheduled();
    const afterFence = await ownerEmail(delayed.id);
    expect(afterFence.state).not.toBe(delayedGuard.mutationState);
    expect(
      Object.keys(afterFence.email.keywords).some((key) =>
        key.startsWith("opensuite_guard_"),
      ),
    ).toBe(false);
    expect(
      value(await mail.draftGuardStatus(actor, "default", delayed.id)).state,
    ).toBe("clear");
    clockOffset = 0;
    const protectedSend = value(
      await mail.schedule(actor, "default", delayed.id, randomUUID(), {
        type: "delay",
        seconds: 30,
      }),
    );
    if (!delayedMove) throw new Error("Missing delayed mutation");
    const lateResponse = await delayedMove();
    expect(JSON.stringify(await lateResponse.json())).toContain(
      "stateMismatch",
    );
    expect(
      (await ownerEmail(delayed.id)).email.mailboxIds[boxId("drafts")],
    ).toBe(true);
    expect(
      value(await mail.cancelScheduled(actor, "default", protectedSend.id))
        .state,
    ).toBe("canceled");

    const draft = value(await mail.createDraft(actor, "default", content));
    lostResponse = "read";
    expect(
      (await mail.updateDraft(actor, "default", draft.id, content)).isErr(),
    ).toBe(true);
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
    await expect(
      database.$executeRaw`UPDATE "ScheduledSend" SET "state" = 'invalid' WHERE "id" = ${requestId}`,
    ).rejects.toThrow(/ScheduledSend_state_check/);
    const guardStatus = await app.inject({
      method: "POST",
      url: "/mail/drafts/guard-status",
      headers,
      payload: { accountId: "default", draftId: draft.id },
    });
    expect(guardStatus.json()).toEqual({ state: "scheduled" });
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
    lostResponse = "flag";
    expect(
      (
        await mail.action(
          actor,
          "default",
          uncertain.threadId,
          { type: "read", value: false },
          [uncertain.draftId],
        )
      ).isErr(),
    ).toBe(true);
    expect(
      (
        await mail.action(
          actor,
          "default",
          uncertain.threadId,
          { type: "read", value: true },
          [uncertain.draftId],
        )
      ).isOk(),
    ).toBe(true);
    const immediateDraft = value(
      await mail.createDraft(actor, "default", {
        ...content,
        subject: "uncertain-immediate",
      }),
    );
    lostResponse = "send";
    expect((await mail.send(actor, "default", immediateDraft.id)).isErr()).toBe(
      true,
    );
    expect(
      value(await mail.draftGuardStatus(actor, "default", immediateDraft.id))
        .state,
    ).toBe("unknown");
    const immediateBefore = immediateAttempts;
    clockOffset = 301_000;
    mail = createService();
    await mail.reconcileScheduled();
    expect(
      value(await mail.draftGuardStatus(actor, "default", immediateDraft.id))
        .state,
    ).toBe("clear");
    expect(immediateAttempts).toBe(immediateBefore);
    clockOffset = 0;
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
    const ambiguousDraft = value(
      await mail.createDraft(actor, "default", content),
    );
    lostResponse = "editDelete";
    expect(
      (
        await mail.updateDraft(actor, "default", ambiguousDraft.id, content)
      ).isErr(),
    ).toBe(true);
    expect(
      value(await mail.draftGuardStatus(actor, "default", ambiguousDraft.id))
        .state,
    ).toBe("unknown");
    clockOffset = 301_000;
    mail = createService();
    await mail.reconcileScheduled();
    expect(
      value(await mail.draftGuardStatus(actor, "default", ambiguousDraft.id))
        .state,
    ).toBe("clear");
    clockOffset = 0;
    const copyDraft = value(await mail.createDraft(actor, "default", content));
    lostResponse = "editCreate";
    expect(
      (await mail.updateDraft(actor, "default", copyDraft.id, content)).isErr(),
    ).toBe(true);
    expect(
      value(await mail.draftGuardStatus(actor, "default", copyDraft.id)).state,
    ).toBe("clear");
    const staleDraft = value(await mail.createDraft(actor, "default", content));
    const staleToken = randomUUID();
    await database.mailDraftGuard.create({
      data: {
        userId: actor.id,
        accountId,
        draftId: staleDraft.id,
        token: staleToken,
        phase: "preparing",
        updatedAt: new Date(Date.now() - 301_000),
      },
    });
    await mail.reconcileScheduled();
    await expect(
      createGuards(database).scheduledStore.beginWrite(
        actor.id,
        accountId,
        [staleDraft.id],
        staleToken,
        "destroy",
      ),
    ).rejects.toThrow("draft guard changed");
    expect(
      value(await mail.draftGuardStatus(actor, "default", staleDraft.id)).state,
    ).toBe("clear");
    const missingDraft = value(
      await mail.createDraft(actor, "default", content),
    );
    lostResponse = "missingCreate";
    const missing = value(
      await mail.schedule(actor, "default", missingDraft.id, randomUUID(), {
        type: "delay",
        seconds: 30,
      }),
    );
    expect(missing.state).toBe("unknown");
    const attempts = submissionAttempts;
    await mail.reconcileScheduled();
    await mail.reconcileScheduled();
    expect(submissionAttempts).toBe(attempts);
    expect(
      value(await mail.scheduled(actor, "default")).scheduled.find(
        (item) => item.id === missing.id,
      )?.state,
    ).toBe("unknown");
    const copyRequest = {
      accountId: "default",
      draftId: missingDraft.id,
      acknowledgeOriginalMayStillSend: true,
    };
    const deniedCopy = await app.inject({
      method: "POST",
      url: "/mail/drafts/recover-copy",
      headers: { ...headers, cookie: "other" },
      payload: copyRequest,
    });
    expect(deniedCopy.statusCode).toBe(403);
    const noAcknowledgement = await app.inject({
      method: "POST",
      url: "/mail/drafts/recover-copy",
      headers,
      payload: { accountId: "default", draftId: missingDraft.id },
    });
    expect(noAcknowledgement.statusCode).toBe(400);
    const originalDraft = value(
      await mail.drafts(actor, "default"),
    ).drafts.find((item) => item.id === missingDraft.id);
    if (!originalDraft) throw new Error("Missing original draft");
    const recoveredCopy = await app.inject({
      method: "POST",
      url: "/mail/drafts/recover-copy",
      headers,
      payload: copyRequest,
    });
    expect(recoveredCopy.statusCode).toBe(200);
    const recovered = RecoveredDraftSchema.parse(recoveredCopy.json());
    expect(recovered).toMatchObject({
      state: "unknown",
      originalMayStillSend: true,
      draft: {
        bcc: content.bcc,
        attachmentBlobIds: originalDraft.attachmentBlobIds,
      },
    });
    expect(recovered.draft.id).not.toBe(missingDraft.id);
    const alice = new JmapClient(base, {
      authorization: `Basic ${Buffer.from(`${actor.email}:${password}`).toString("base64")}`,
      rewriteSessionUrlsToOrigin: base,
    });
    const aliceSession = value(await alice.discover());
    const copiedEmails = value(
      await alice.emails(aliceSession, accountId, [
        missingDraft.id,
        recovered.draft.id,
      ]),
    ).list;
    const sourceEmail = copiedEmails.find(
      (item) => item.id === missingDraft.id,
    );
    const copiedEmail = copiedEmails.find(
      (item) => item.id === recovered.draft.id,
    );
    if (!sourceEmail || !copiedEmail)
      throw new Error("Missing recovered email");
    expect(recovered.draft.threadId).toBe(copiedEmail.threadId);
    expect(
      copiedEmail.attachments.map(({ name, type, size }) => ({
        name,
        type,
        size,
      })),
    ).toEqual(
      sourceEmail.attachments.map(({ name, type, size }) => ({
        name,
        type,
        size,
      })),
    );
    expect(
      (
        await mail.updateDraft(
          actor,
          "default",
          recovered.draft.id,
          recovered.draft,
        )
      ).isOk(),
    ).toBe(true);
    expect(
      value(await mail.cancelScheduled(actor, "default", missing.id)).state,
    ).toBe("unknown");
    expect(submissionAttempts).toBe(attempts);
    expect(
      (
        await mail.schedule(actor, "default", ambiguousDraft.id, randomUUID(), {
          type: "delay",
          seconds: 30,
        })
      ).isErr(),
    ).toBe(true);
    const externallyCanceledDraft = value(
      await mail.createDraft(actor, "default", content),
    );
    const externallyCanceled = value(
      await mail.schedule(
        actor,
        "default",
        externallyCanceledDraft.id,
        randomUUID(),
        { type: "delay", seconds: 30 },
      ),
    );
    const submissionRow = await database.scheduledSend.findUniqueOrThrow({
      where: { id: externallyCanceled.id },
    });
    if (!submissionRow.submissionId)
      throw new Error("Missing scheduled submission");
    expect(
      (
        await alice.scheduled.cancelSubmission(
          aliceSession,
          accountId,
          submissionRow.submissionId,
        )
      ).isOk(),
    ).toBe(true);
    clockOffset = 31_000;
    const attemptsBeforeReconcile = submissionAttempts;
    await mail.reconcileScheduled();
    expect(submissionAttempts).toBe(attemptsBeforeReconcile);
    expect(
      value(await mail.scheduled(actor, "default")).scheduled.find(
        (item) => item.id === missing.id,
      )?.state,
    ).toBe("unknown");
    expect(
      value(await mail.scheduled(actor, "default")).scheduled.find(
        (item) => item.id === externallyCanceled.id,
      )?.state,
    ).toBe("canceled");
    clockOffset = 0;
    expect(
      (
        await mail.updateDraft(
          actor,
          "default",
          externallyCanceledDraft.id,
          content,
        )
      ).isOk(),
    ).toBe(true);
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
    ).toBe("unknown");
    clockOffset = 0;
    expect(
      (await mail.cancelScheduled(actor, "default", uncertain.id)).match(
        (v) => v.state,
        () => "error",
      ),
    ).toBe("sent");
    const neverSent = value(await mail.createDraft(actor, "default", content));
    lostResponse = "missingSend";
    expect((await mail.send(actor, "default", neverSent.id)).isErr()).toBe(
      true,
    );
    const immediateBeforeRecovery = immediateAttempts;
    clockOffset = 301_000;
    await expect(mail.reconcileScheduled()).rejects.toThrow(
      "scheduled reconciliation incomplete",
    );
    expect(immediateAttempts).toBe(immediateBeforeRecovery);
    expect(
      value(await mail.draftGuardStatus(actor, "default", neverSent.id)).state,
    ).toBe("unknown");
    clockOffset = 0;
    const recoveredImmediate = await app.inject({
      method: "POST",
      url: "/mail/drafts/recover-copy",
      headers,
      payload: {
        accountId: "default",
        draftId: neverSent.id,
        acknowledgeOriginalMayStillSend: true,
      },
    });
    expect(recoveredImmediate.statusCode).toBe(200);
    expect(RecoveredDraftSchema.parse(recoveredImmediate.json())).toMatchObject(
      { state: "unknown", originalMayStillSend: true },
    );
  } finally {
    await app.close();
  }
}, 180_000);
