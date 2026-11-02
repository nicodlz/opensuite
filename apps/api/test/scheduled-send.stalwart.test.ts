import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { RecoveredDraftSchema } from "@opensuite/contracts";
import { createReadinessService } from "@opensuite/core";
import { createMailWithInvitations } from "@opensuite/core/services/invitations";
import { invitationProtocol } from "@opensuite/core/adapters/invitations";
import {
  createAliasStore,
  createDatabase,
  createScheduledSendStore,
  type PrismaClient,
} from "@opensuite/db";
import { createGuards as createScheduledGuards } from "../src/adapters/scheduled-send-job.ts";
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
    await db.mailboxLink.create({
      data: {
        userId: actor.id,
        accountId,
        address: actor.email,
        credentialId: "fixture",
        secret: "v1.AAAAAAAAAAAAAAAA.A.AAAAAAAAAAAAAAAAAAAAAA",
        status: "active",
      },
    });
    const domainRow = await db.domain.create({
      data: {
        userId: actor.id,
        name: "example.test",
        status: "verified",
        stalwartId: domain.id,
      },
    });
    const address = await db.address.create({
      data: {
        userId: actor.id,
        domainId: domainRow.id,
        localPart: "alias",
        isAlias: true,
      },
    });
    await db.emailAlias.create({
      data: {
        userId: actor.id,
        domainId: domainRow.id,
        addressId: address.id,
        address: "alias@example.test",
        localPart: "alias",
        enabled: true,
        ready: true,
      },
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
    | "cancelBefore"
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
  let cancellationAttempts = 0;
  let delayedMove: (() => Promise<Response>) | undefined;
  let afterQuery: (() => Promise<void>) | undefined;
  let afterQueryFor = "";
  let entitled = true;
  let quota: number | null = null;
  let used = 0;
  let measured = true;
  let afterMeasure: (() => Promise<void>) | undefined;
  const aliasStore = createAliasStore(database);
  const aliases = {
    canSendAs: async (userId: string, address: string) =>
      (await aliasStore.canSendAs(userId, address)).map(
        (row) => row?.id ?? null,
      ),
  };
  const addresses = { canSendAs: () => Promise.resolve(ok(null)) };
  const fetchMaybeLose: typeof fetch = async (input, init) => {
    const body = typeof init?.body === "string" ? init.body : "";
    const guardedMove =
      body.includes('"Email/set"') &&
      body.includes('"mailboxIds"') &&
      body.includes('"ifInState"');
    if (body.includes("HOLDFOR")) submissionAttempts++;
    if (body.includes('"EmailSubmission/set"') && body.includes('"canceled"'))
      cancellationAttempts++;
    if (body.includes('"EmailSubmission/set"') && !body.includes("HOLDFOR"))
      immediateAttempts++;
    if (lostResponse === "missingCreate" && body.includes("HOLDFOR")) {
      lostResponse = null;
      throw new Error("submission request lost");
    }
    if (lostResponse === "cancelBefore" && body.includes('"canceled"')) {
      lostResponse = null;
      throw new Error("cancellation request lost");
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
      afterQuery &&
      body.includes('"EmailSubmission/query"') &&
      body.includes(afterQueryFor)
    ) {
      const hook = afterQuery;
      afterQuery = undefined;
      await hook();
    }
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
  const createService = (domains = ["example.test"]) =>
    createMailWithInvitations({
      origin: base,
      now: () => Date.now() + clockOffset,
      store: credentials,
      ...createScheduledGuards(database, {
        aliases,
        addresses,
        domains,
        entitlements: {
          get: () =>
            Promise.resolve({ uploadsAllowed: entitled, quotaBytes: quota }),
        },
        storageMeter: {
          measure: async () => {
            await afterMeasure?.();
            return { usedBytes: used, measured };
          },
        },
      }),
      protocol: invitationProtocol,
      aliases,
      addresses,
      beforeAliasSend: () => Promise.resolve(true),
      client: ({ address, secret }) =>
        new JmapClient(base, {
          authorization: `Basic ${Buffer.from(`${address}:${secret}`).toString("base64")}`,
          fetch: fetchMaybeLose,
          rewriteSessionUrlsToOrigin: base,
        }),
    }).mail;
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
    // The server holds the item itself; the provider has no queued submission.
    expect(submissionAttempts).toBe(0);
    const queued = value(
      await mail.schedule(actor, "default", edited.id, randomUUID(), {
        type: "at",
        at: new Date(Date.now() + 30_000).toISOString(),
      }),
    );
    expect(queued.state).toBe("pending");
    expect(
      value(
        await ownerClient.scheduled.submissionIds(
          ownerSession,
          accountId,
          edited.id,
        ),
      ).ids,
    ).toEqual([]);
    const before = immediateAttempts;
    mail = createService();
    await mail.reconcileScheduled();
    expect(immediateAttempts).toBe(before);
    clockOffset = 31_000;
    const secondWorker = createService();
    await Promise.all([
      mail.reconcileScheduled(),
      secondWorker.reconcileScheduled(),
    ]);
    expect(immediateAttempts).toBe(before + 1);
    expect(
      value(await mail.scheduled(actor, "default")).scheduled.find(
        (x) => x.id === queued.id,
      )?.state,
    ).toBe("sent");
    expect(submissionAttempts).toBe(0);
    await pause(2000);
    const blind = new JmapClient(base, {
      authorization: `Basic ${Buffer.from(`blind@example.test:${password}`).toString("base64")}`,
      rewriteSessionUrlsToOrigin: base,
    });
    const blindSession = value(await blind.discover());
    const blindId = blindSession.primaryAccounts["urn:ietf:params:jmap:mail"];
    if (!blindId) throw new Error("Missing blind recipient");
    const deliveries = value(
      await blind.queryEmails(blindSession, blindId, {
        filter: { subject: "rescheduled-api" },
      }),
    ).ids;
    expect(deliveries).toHaveLength(1);
    const received = value(
      await blind.emails(blindSession, blindId, deliveries),
    ).list[0];
    expect(received?.from?.[0]?.email).toBe("alias@example.test");
    expect(received?.attachments).toHaveLength(1);

    // Cancel remains definitive even after the deadline until handoff wins.
    clockOffset = 0;
    const canceledDraft = value(
      await mail.createDraft(actor, "default", content),
    );
    const canceledItem = value(
      await mail.schedule(actor, "default", canceledDraft.id, randomUUID(), {
        type: "delay",
        seconds: 30,
      }),
    );
    clockOffset = 31_000;
    expect(
      value(await mail.cancelScheduled(actor, "default", canceledItem.id))
        .state,
    ).toBe("canceled");
    expect(
      (
        await mail.updateDraft(actor, "default", canceledDraft.id, content)
      ).isOk(),
    ).toBe(true);
    expect(cancellationAttempts).toBe(0);

    // Cancellation and worker handoff use a single database transition.
    clockOffset = 0;
    const raceDraft = value(await mail.createDraft(actor, "default", content));
    const race = value(
      await mail.schedule(actor, "default", raceDraft.id, randomUUID(), {
        type: "delay",
        seconds: 1,
      }),
    );
    afterQueryFor = raceDraft.id;
    afterQuery = async () => {
      expect(
        value(await mail.cancelScheduled(actor, "default", race.id)).state,
      ).toBe("canceled");
    };
    clockOffset = 2000;
    const beforeRace = immediateAttempts;
    await mail.reconcileScheduled();
    expect(immediateAttempts).toBe(beforeRace);
    expect(
      value(await mail.scheduled(actor, "default")).scheduled.find(
        (x) => x.id === race.id,
      )?.state,
    ).toBe("canceled");

    // A worker that dies before handoff loses its expired lease; its token
    // cannot later submit once another worker has taken over.
    clockOffset = 0;
    const leaseDraft = value(await mail.createDraft(actor, "default", content));
    const lease = value(
      await mail.schedule(actor, "default", leaseDraft.id, randomUUID(), {
        type: "delay",
        seconds: 1,
      }),
    );
    const store = createScheduledSendStore(database);
    clockOffset = 2000;
    const staleToken = randomUUID();
    expect(
      await store.claim(
        lease.id,
        new Date(Date.now() + clockOffset),
        staleToken,
      ),
    ).toBe(true);
    clockOffset = 63_000;
    const beforeLease = immediateAttempts;
    await createService().reconcileScheduled();
    expect(immediateAttempts).toBe(beforeLease + 1);
    expect(
      await store.beginSubmission(
        lease.id,
        staleToken,
        new Date(Date.now() + clockOffset),
        [],
      ),
    ).toBe(false);
    expect(
      value(await mail.scheduled(actor, "default")).scheduled.find(
        (x) => x.id === lease.id,
      )?.state,
    ).toBe("sent");

    // Verified custom domains remain valid without being listed as a configured
    // shared domain; alias ownership still comes from the alias store.
    clockOffset = 0;
    const customService = createService([]);
    const customDraft = value(
      await customService.createDraft(actor, "default", content),
    );
    const custom = value(
      await customService.schedule(
        actor,
        "default",
        customDraft.id,
        randomUUID(),
        { type: "delay", seconds: 1 },
      ),
    );
    clockOffset = 2000;
    await customService.reconcileScheduled();
    expect(
      value(await customService.scheduled(actor, "default")).scheduled.find(
        (x) => x.id === custom.id,
      )?.state,
    ).toBe("sent");

    // Revoke each authorization after queueing, including during the final provider read.
    const failureCases = [
      {
        reason: "account_inactive",
        set: () =>
          database.user.update({
            where: { id: actor.id },
            data: { disabled: true },
          }),
        reset: () =>
          database.user.update({
            where: { id: actor.id },
            data: { disabled: false },
          }),
      },
      {
        reason: "domain_unavailable",
        set: () =>
          database.domain.update({
            where: { name: "example.test" },
            data: { removalPending: true },
          }),
        reset: () =>
          database.domain.update({
            where: { name: "example.test" },
            data: { removalPending: false },
          }),
      },
      {
        reason: "entitlement_required",
        set: () => {
          entitled = false;
          return Promise.resolve();
        },
        reset: () => {
          entitled = true;
          return Promise.resolve();
        },
      },
      {
        reason: "quota_exceeded",
        set: () => {
          quota = 100;
          used = 100;
          return Promise.resolve();
        },
        reset: () => {
          quota = null;
          used = 0;
          return Promise.resolve();
        },
      },
    ];
    await failureCases.reduce<Promise<void>>(
      (previous, test) =>
        previous.then(async () => {
          clockOffset = 0;
          const draftToBlock = value(
            await mail.createDraft(actor, "default", content),
          );
          const item = value(
            await mail.schedule(
              actor,
              "default",
              draftToBlock.id,
              randomUUID(),
              {
                type: "delay",
                seconds: 1,
              },
            ),
          );
          await test.set();
          clockOffset = 2000;
          const attempts = immediateAttempts;
          await mail.reconcileScheduled();
          await test.reset();
          // Re-enable the fixture alias after the account-state trigger queues
          // its normal provider reconciliation.
          await database.emailAlias.update({
            where: { address: "alias@example.test" },
            data: { ready: true },
          });
          expect(immediateAttempts).toBe(attempts);
          const failed = value(
            await mail.scheduled(actor, "default"),
          ).scheduled.find((x) => x.id === item.id);
          expect(failed).toMatchObject({
            state: "failed",
            failure: { code: test.reason },
          });
          const editedAfterFailure = await mail.updateDraft(
            actor,
            "default",
            draftToBlock.id,
            content,
          );
          if (editedAfterFailure.isErr())
            throw new Error(
              `${test.reason}: edit failed: ${JSON.stringify(editedAfterFailure.error)}`,
            );
          expect(
            await database.auditEvent.count({
              where: {
                userId: actor.id,
                action: "mail.scheduled.failed",
                detail: { path: ["scheduledId"], equals: item.id },
              },
            }),
          ).toBe(1);
          return undefined;
        }),
      Promise.resolve(),
    );
    clockOffset = 0;
    const revokedDraft = value(
      await mail.createDraft(actor, "default", content),
    );
    const revoked = value(
      await mail.schedule(actor, "default", revokedDraft.id, randomUUID(), {
        type: "delay",
        seconds: 1,
      }),
    );
    afterQueryFor = revokedDraft.id;
    afterQuery = async () => {
      await database.emailAlias.update({
        where: { address: "alias@example.test" },
        data: { enabled: false },
      });
    };
    clockOffset = 2000;
    const beforeRevoke = immediateAttempts;
    await mail.reconcileScheduled();
    expect(immediateAttempts).toBe(beforeRevoke);
    expect(
      value(await mail.scheduled(actor, "default")).scheduled.find(
        (x) => x.id === revoked.id,
      ),
    ).toMatchObject({
      state: "failed",
      failure: { code: "sender_unavailable" },
    });
    expect(
      await database.auditEvent.count({
        where: {
          action: "mail.scheduled.failed",
          detail: { path: ["scheduledId"], equals: revoked.id },
        },
      }),
    ).toBe(1);
    await database.emailAlias.update({
      where: { address: "alias@example.test" },
      data: { enabled: true },
    });

    // Even if the application alias still exists, a missing provider identity
    // fails release and records why instead of handing off the draft.
    clockOffset = 0;
    const noIdentityDraft = value(
      await mail.createDraft(actor, "default", content),
    );
    const noIdentity = value(
      await mail.schedule(actor, "default", noIdentityDraft.id, randomUUID(), {
        type: "delay",
        seconds: 1,
      }),
    );
    const admin = new StalwartAdmin(base, {
      username: "admin",
      password: "integration-password",
    });
    const domain = await database.domain.findUniqueOrThrow({
      where: { name: "example.test" },
    });
    if (!domain.stalwartId) throw new Error("Missing domain id");
    expect(
      (await admin.removeAlias(accountId, "alias", domain.stalwartId)).isOk(),
    ).toBe(true);
    clockOffset = 2000;
    const beforeIdentity = immediateAttempts;
    await mail.reconcileScheduled();
    expect(immediateAttempts).toBe(beforeIdentity);
    expect(
      value(await mail.scheduled(actor, "default")).scheduled.find(
        (x) => x.id === noIdentity.id,
      ),
    ).toMatchObject({
      state: "failed",
      failure: { code: "sender_unavailable" },
    });
    expect(
      await database.auditEvent.count({
        where: {
          action: "mail.scheduled.failed",
          detail: { path: ["scheduledId"], equals: noIdentity.id },
        },
      }),
    ).toBe(1);
    value(await admin.createAlias(accountId, "alias", domain.stalwartId));

    // Sender authorization is checked after slow quota measurement, and the
    // entitlement is re-read if billing changes while usage is measured.
    const duringMeasurement = [
      {
        reason: "sender_unavailable",
        revoke: async () => {
          await database.emailAlias.update({
            where: { address: "alias@example.test" },
            data: { enabled: false },
          });
        },
        restore: async () => {
          await database.emailAlias.update({
            where: { address: "alias@example.test" },
            data: { enabled: true },
          });
        },
      },
      {
        reason: "entitlement_required",
        revoke: () => {
          entitled = false;
          return Promise.resolve();
        },
        restore: () => {
          entitled = true;
          return Promise.resolve();
        },
      },
    ];
    await duringMeasurement.reduce<Promise<void>>(
      (previous, test) =>
        previous.then(async () => {
          clockOffset = 0;
          quota = 1_000_000;
          used = 0;
          const draftToBlock = value(
            await mail.createDraft(actor, "default", content),
          );
          const item = value(
            await mail.schedule(
              actor,
              "default",
              draftToBlock.id,
              randomUUID(),
              { type: "delay", seconds: 1 },
            ),
          );
          let measurements = 0;
          afterMeasure = async () => {
            measurements++;
            if (measurements === 2) await test.revoke();
          };
          clockOffset = 2000;
          const beforeMeasurement = immediateAttempts;
          await mail.reconcileScheduled();
          afterMeasure = undefined;
          await test.restore();
          quota = null;
          expect(immediateAttempts).toBe(beforeMeasurement);
          expect(
            value(await mail.scheduled(actor, "default")).scheduled.find(
              (x) => x.id === item.id,
            ),
          ).toMatchObject({ state: "failed", failure: { code: test.reason } });
          return undefined;
        }),
      Promise.resolve(),
    );

    // Incomplete quota information defers instead of authorizing or failing the item.
    clockOffset = 0;
    const deferredDraft = value(
      await mail.createDraft(actor, "default", content),
    );
    const deferred = value(
      await mail.schedule(actor, "default", deferredDraft.id, randomUUID(), {
        type: "delay",
        seconds: 1,
      }),
    );
    quota = 100;
    measured = false;
    clockOffset = 2000;
    await expect(mail.reconcileScheduled()).rejects.toThrow(
      "scheduled reconciliation incomplete",
    );
    expect(
      value(await mail.scheduled(actor, "default")).scheduled.find(
        (x) => x.id === deferred.id,
      )?.state,
    ).toBe("pending");
    expect(
      value(await mail.cancelScheduled(actor, "default", deferred.id)).state,
    ).toBe("canceled");
    quota = null;
    measured = true;

    // A crash after committing the handoff marker is uncertain, even if the
    // process died before issuing the provider request.
    clockOffset = 0;
    const crashDraft = value(await mail.createDraft(actor, "default", content));
    const crash = value(
      await mail.schedule(actor, "default", crashDraft.id, randomUUID(), {
        type: "delay",
        seconds: 1,
      }),
    );
    clockOffset = 2000;
    const crashToken = randomUUID();
    const crashTime = new Date(Date.now() + clockOffset);
    expect(await store.claim(crash.id, crashTime, crashToken)).toBe(true);
    expect(
      await store.beginSubmission(crash.id, crashToken, crashTime, []),
    ).toBe(true);
    const beforeCrashRecovery = immediateAttempts;
    await createService().reconcileScheduled();
    expect(immediateAttempts).toBe(beforeCrashRecovery);
    expect(
      value(await mail.cancelScheduled(actor, "default", crash.id)).state,
    ).toBe("unknown");

    // An interrupted provider request stays uncertain and never gets submitted twice.
    clockOffset = 0;
    const uncertainDraft = value(
      await mail.createDraft(actor, "default", content),
    );
    const uncertain = value(
      await mail.schedule(actor, "default", uncertainDraft.id, randomUUID(), {
        type: "delay",
        seconds: 1,
      }),
    );
    lostResponse = "missingSend";
    clockOffset = 2000;
    await mail.reconcileScheduled();
    const uncertainAttempts = immediateAttempts;
    mail = createService();
    await mail.reconcileScheduled();
    await mail.reconcileScheduled();
    expect(immediateAttempts).toBe(uncertainAttempts);
    expect(
      value(await mail.cancelScheduled(actor, "default", uncertain.id)).state,
    ).toBe("unknown");
    const recovered = await app.inject({
      method: "POST",
      url: "/mail/drafts/recover-copy",
      headers,
      payload: {
        accountId: "default",
        draftId: uncertainDraft.id,
        acknowledgeOriginalMayStillSend: true,
      },
    });
    expect(recovered.statusCode).toBe(200);
    expect(RecoveredDraftSchema.parse(recovered.json())).toMatchObject({
      state: "unknown",
      originalMayStillSend: true,
    });

    // An accepted submission with a lost response is reconciled without a second send.
    clockOffset = 0;
    const acceptedDraft = value(
      await mail.createDraft(actor, "default", {
        ...content,
        subject: "lost-submission-response",
      }),
    );
    const accepted = value(
      await mail.schedule(actor, "default", acceptedDraft.id, randomUUID(), {
        type: "delay",
        seconds: 1,
      }),
    );
    lostResponse = "send";
    clockOffset = 2000;
    await mail.reconcileScheduled();
    const acceptedAttempts = immediateAttempts;
    mail = createService();
    await mail.reconcileScheduled();
    expect(immediateAttempts).toBe(acceptedAttempts);
    expect(
      value(await mail.scheduled(actor, "default")).scheduled.find(
        (x) => x.id === accepted.id,
      )?.state,
    ).toBe("sent");
  } finally {
    await app.close();
  }
}, 180_000);
