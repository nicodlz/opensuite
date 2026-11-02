import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import {
  createDatabase,
  createInvitationStore,
  createOrganizedInvitationStore,
  type PrismaClient,
} from "@opensuite/db";
import { JmapClient } from "@opensuite/jmap";
import { StalwartAdmin } from "@opensuite/jmap/admin";
import { err, ok, type Result } from "neverthrow";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import {
  invitationProtocol,
  organizerProtocol,
} from "../../src/adapters/invitations.ts";
import { createCalendarService } from "../../src/services/calendar.ts";
import { createOrganizerService } from "../../src/services/invitations-outbound.ts";
import type { MailCredentialStore } from "../../src/services/jmap-access.ts";

const run = promisify(execFile);
const project = `organizer-identity-${randomBytes(8).toString("hex")}`;
const overlay = `/tmp/${project}.yaml`;
const actor = {
  id: "alice",
  email: "alice@example.test",
  role: "user" as const,
};
const alias = "meeting@example.test";
const password = "test-password-for-identity-9841!";
let db: PrismaClient;
let base = "";
let admin: StalwartAdmin;
let accountId = "";
let domainId = "";
let calendarId = "";
let credentials: MailCredentialStore;

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
        "-f",
        overlay,
        ...args,
      ],
      { cwd: new URL("../../../../", import.meta.url), maxBuffer: 4_000_000 },
    )
  ).stdout;
const unwrap = <T>(result: Result<T, { kind: string }>): T =>
  result.match(
    (value) => value,
    (error) => {
      throw new Error(JSON.stringify(error));
    },
  );
const ready = async (attempts: number): Promise<void> => {
  try {
    if ((await fetch(`${base}/healthz/ready`)).ok) return;
  } catch {
    /* starting */
  }
  if (!attempts) throw new Error("Stalwart did not start");
  await new Promise((resolve) => setTimeout(resolve, 500));
  await ready(attempts - 1);
};
const makeClient = () =>
  new JmapClient(base, {
    authorization: `Basic ${Buffer.from(`${actor.email}:${password}`).toString("base64")}`,
    rewriteSessionUrlsToOrigin: base,
  });
type SenderState = {
  authorization: "allowed" | "revoked" | "unavailable";
  changed: boolean;
  duplicate?: boolean;
};
function makeService(
  client: JmapClient,
  state: SenderState,
  beforeSend = () => Promise.resolve(true),
) {
  const identities = client.identities.bind(client);
  client.identities = async (...args) => {
    const response = await identities(...args);
    if (response.isErr()) return response;
    const original = response.value.list.find(
      (identity) => identity.email.toLowerCase() === alias,
    );
    if (state.duplicate && original)
      return ok({
        ...response.value,
        list: [
          Object.assign({}, original, { id: `other-${original.id}` }),
          ...response.value.list,
        ],
      });
    if (!state.changed) return response;
    return ok({
      ...response.value,
      list: response.value.list.map((identity) =>
        identity.email.toLowerCase() === alias
          ? Object.assign({}, identity, { id: `replacement-${identity.id}` })
          : identity,
      ),
    });
  };
  return createOrganizerService({
    origin: base,
    store: credentials,
    client: () => client,
    organized: createOrganizedInvitationStore(db),
    intentions: createInvitationStore(db),
    protocol: invitationProtocol,
    organizerProtocol,
    canSendAs: (_userId, address) =>
      state.authorization === "unavailable"
        ? Promise.reject(new Error("lookup failed"))
        : Promise.resolve(
            address === alias && state.authorization === "allowed"
              ? "alias:meeting"
              : null,
          ),
    beforeAliasSend: beforeSend,
  });
}
const input = () => ({
  accountId: "default",
  requestId: randomUUID(),
  eventId: null,
  organizer: alias,
  attendees: ["bob@example.test"],
  cancel: false,
  event: {
    calendarId,
    title: "Identity recovery",
    description: "",
    location: "",
    start: "2026-11-20T10:00:00.000Z",
    end: "2026-11-20T11:00:00.000Z",
    allDay: false,
    timeZone: "UTC",
    recurrence: "none" as const,
  },
});

beforeAll(async () => {
  try {
    await writeFile(
      overlay,
      `services:\n  postgres:\n    image: postgres:18.6\n    environment:\n      POSTGRES_PASSWORD: test-password\n      POSTGRES_INITDB_ARGS: --no-sync\n    command: ["postgres", "-c", "fsync=off"]\n    ports: ["127.0.0.1::5432"]\n`,
    );
    await compose("up", "-d");
    const databaseReady = async (attempts: number): Promise<void> => {
      try {
        await compose("exec", "-T", "postgres", "pg_isready", "-U", "postgres");
      } catch (error) {
        if (!attempts) throw error;
        await new Promise((resolve) => setTimeout(resolve, 500));
        await databaseReady(attempts - 1);
      }
    };
    await databaseReady(120);
    const dbPort = (await compose("port", "postgres", "5432"))
      .trim()
      .split(":")
      .at(-1);
    if (!dbPort) throw new Error("Missing database port");
    const databaseUrl = `postgresql://postgres:test-password@127.0.0.1:${dbPort}/postgres`;
    await run(
      "pnpm",
      ["--filter", "@opensuite/db", "exec", "prisma", "migrate", "deploy"],
      {
        cwd: new URL("../../../../", import.meta.url),
        env: { ...process.env, DATABASE_URL: databaseUrl },
        maxBuffer: 4_000_000,
      },
    );
    db = unwrap(createDatabase(databaseUrl));
    await db.user.create({
      data: { id: actor.id, email: actor.email, name: "Alice" },
    });
    const port = (await compose("port", "stalwart", "8080"))
      .trim()
      .split(":")
      .at(-1);
    if (!port) throw new Error("Missing Stalwart port");
    base = `http://127.0.0.1:${port}`;
    await ready(120);
    admin = new StalwartAdmin(base, {
      username: "admin",
      password: "integration-password",
    });
    const domain = unwrap(await admin.createDomain("example.test"));
    const account = unwrap(
      await admin.createAccount("alice", domain.id, password),
    );
    unwrap(await admin.createAccount("bob", domain.id, password));
    unwrap(await admin.createAccount("carol", domain.id, password));
    accountId = account.id;
    domainId = domain.id;
    credentials = {
      getForOwner: (userId, requested) =>
        Promise.resolve(
          userId === actor.id &&
            (requested === "default" || requested === accountId)
            ? ok({ accountId, address: actor.email, secret: password })
            : err({ kind: "forbidden" }),
        ),
    };
    const calendars = unwrap(
      await createCalendarService({
        origin: base,
        store: credentials,
      }).calendars(actor, "default"),
    ).calendars;
    calendarId = calendars[0]?.id ?? "";
    if (!calendarId) throw new Error("Missing calendar");
  } catch (error) {
    await compose("down", "--volumes", "--remove-orphans").catch(
      () => undefined,
    );
    await rm(overlay, { force: true });
    throw error;
  }
}, 180_000);

const disconnect = async (database: PrismaClient | undefined) => {
  if (database) await database.$disconnect();
};
beforeEach(async () => {
  unwrap(await admin.createAlias(accountId, "meeting", domainId));
});
afterAll(async () => {
  await disconnect(db);
  await compose("down", "--volumes", "--remove-orphans");
  await rm(overlay, { force: true });
}, 60_000);

it.each([
  { stage: "reserved", loss: "revoked" },
  { stage: "reserved", loss: "changed" },
  { stage: "reserved", loss: "missing" },
  { stage: "prepared", loss: "revoked" },
  { stage: "prepared", loss: "changed" },
  { stage: "prepared", loss: "missing" },
] as const)(
  "abandons a $stage delivery after the sender is $loss",
  async ({ stage, loss }) => {
    const state: SenderState = { authorization: "allowed", changed: false };
    const client = makeClient();
    const realCreate = client.createCalendarEvent.bind(client);
    const realSubmit = client.submit.bind(client);
    let submits = 0;
    if (stage === "reserved")
      client.createCalendarEvent = async (...args) => {
        const result = await realCreate(...args);
        if (result.isOk()) state.authorization = "unavailable";
        return result;
      };
    client.submit = () => {
      submits += 1;
      return Promise.resolve(
        err({ kind: "network", message: "not sent", beforeRequest: true }),
      );
    };
    const service = makeService(client, state);
    const request = input();
    expect(unwrap(await service.organize(actor, request)).state).toBe(
      "pending",
    );
    const before = await db.organizedOperation.findUniqueOrThrow({
      where: { id: request.requestId },
      include: { series: true, deliveries: true },
    });
    expect(before.deliveries[0]?.phase).toBe(stage);
    expect(before.deliveries[0]?.identityId).toBeTruthy();
    expect(before.series.pendingId).toBe(request.requestId);
    state.authorization = loss === "revoked" ? "revoked" : "allowed";
    state.changed = loss === "changed";
    if (loss === "missing")
      unwrap(await admin.removeAlias(accountId, "meeting", domainId));
    const failed = unwrap(
      await service.reconcile(actor, "default", request.requestId),
    );
    expect(failed).toMatchObject({
      state: "failed",
      failedRecipients: [
        { email: "bob@example.test", reason: "sender_unavailable" },
      ],
    });
    const after = await db.organizedOperation.findUniqueOrThrow({
      where: { id: request.requestId },
      include: { series: true, deliveries: true },
    });
    expect(after.series.pendingId).toBeNull();
    expect(after.deliveries[0]?.phase).toBe("rejected:sender");
    expect(submits).toBe(stage === "reserved" ? 0 : 1);
    expect(unwrap(await service.organize(actor, request))).toEqual(failed);
    unwrap(await admin.createAlias(accountId, "meeting", domainId));
    state.authorization = "allowed";
    state.changed = false;
    client.submit = realSubmit;
    const retried = unwrap(
      await service.organize(actor, {
        ...request,
        requestId: randomUUID(),
        eventId: failed.eventId,
        event: { ...request.event, title: "Identity restored" },
      }),
    );
    expect(retried.state).toBe("sent");
  },
  120_000,
);

it.each(["recorded", "unconfirmed"] as const)(
  "keeps an ambiguous %s submission fenced after authorization loss",
  async (outcome) => {
    const state: SenderState = { authorization: "allowed", changed: false };
    const client = makeClient();
    const realSubmit = client.submit.bind(client);
    let submits = 0;
    client.submit = async (...args) => {
      submits += 1;
      if (outcome === "recorded") unwrap(await realSubmit(...args));
      state.authorization = "revoked";
      return err({ kind: "network", message: "response lost" });
    };
    const service = makeService(client, state);
    const request = input();
    expect(unwrap(await service.organize(actor, request)).state).toBe(
      "pending",
    );
    if (outcome === "unconfirmed")
      unwrap(await admin.removeAlias(accountId, "meeting", domainId));
    const recovered = unwrap(
      await service.reconcile(actor, "default", request.requestId),
    );
    expect(recovered.state).toBe(outcome === "recorded" ? "sent" : "pending");
    const stored = await db.organizedOperation.findUniqueOrThrow({
      where: { id: request.requestId },
      include: { series: true, deliveries: true },
    });
    expect(stored.series.pendingId).toBe(
      outcome === "recorded" ? null : request.requestId,
    );
    expect(stored.deliveries[0]?.phase.startsWith("sending:")).toBe(
      outcome === "unconfirmed",
    );
    expect(submits).toBe(1);
    expect(unwrap(await service.organize(actor, request)).state).toBe(
      recovered.state,
    );
    expect(submits).toBe(1);
  },
  120_000,
);

it("fences an in-flight draft when the alias is revoked", async () => {
  const state: SenderState = { authorization: "allowed", changed: false };
  const client = makeClient();
  const upload = client.upload.bind(client);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let submits = 0;
  client.upload = async (...args) => {
    if (args[3]?.includes("method=REQUEST")) {
      entered.resolve();
      await release.promise;
    }
    return upload(...args);
  };
  client.submit = () => {
    submits += 1;
    return Promise.resolve(err({ kind: "network", message: "unexpected" }));
  };
  const service = makeService(client, state);
  const request = input();
  const first = service.organize(actor, request);
  await entered.promise;
  state.authorization = "revoked";
  let recovered;
  try {
    recovered = unwrap(
      await service.reconcile(actor, "default", request.requestId),
    );
  } finally {
    release.resolve();
  }
  expect(recovered.state).toBe("failed");
  expect(unwrap(await first).state).toBe("failed");
  expect(submits).toBe(0);
  const stored = await db.organizedOperation.findUniqueOrThrow({
    where: { id: request.requestId },
    include: { series: true, deliveries: true },
  });
  expect(stored.series.pendingId).toBeNull();
  expect(stored.deliveries[0]?.phase).toBe("rejected:sender");
}, 120_000);

it("abandons before submitting if authorization changes at the send boundary", async () => {
  const state: SenderState = { authorization: "allowed", changed: false };
  const client = makeClient();
  let submits = 0;
  client.submit = () => {
    submits += 1;
    return Promise.resolve(err({ kind: "network", message: "unexpected" }));
  };
  const service = makeService(client, state, () => {
    state.authorization = "revoked";
    return Promise.resolve(true);
  });
  const result = unwrap(await service.organize(actor, input()));
  expect(result).toMatchObject({
    state: "failed",
    failedRecipients: [
      { email: "bob@example.test", reason: "sender_unavailable" },
    ],
  });
  expect(submits).toBe(0);
}, 120_000);

it("reports only unsent recipients if authorization is revoked partway through delivery", async () => {
  const state: SenderState = { authorization: "allowed", changed: false };
  const client = makeClient();
  const realSubmit = client.submit.bind(client);
  let submissions = 0;
  client.submit = async (...args) => {
    submissions += 1;
    const result = await realSubmit(...args);
    if (result.isOk()) state.authorization = "revoked";
    return result;
  };
  const service = makeService(client, state);
  const request = {
    ...input(),
    attendees: ["bob@example.test", "carol@example.test"],
  };
  const result = unwrap(await service.organize(actor, request));
  expect(result).toMatchObject({
    state: "failed",
    failedRecipients: [
      { email: "carol@example.test", reason: "sender_unavailable" },
    ],
  });
  const stored = await db.organizedOperation.findUniqueOrThrow({
    where: { id: request.requestId },
    include: { series: true, deliveries: true },
  });
  expect(stored.series.pendingId).toBeNull();
  expect(
    stored.deliveries.map((delivery) => delivery.phase).toSorted(),
  ).toEqual(["rejected:sender", "sent"]);
  expect(submissions).toBe(1);
}, 120_000);

it("retains and retries a delivery when the authorization lookup is temporarily unavailable", async () => {
  const state: SenderState = { authorization: "allowed", changed: false };
  const client = makeClient();
  const realCreate = client.createCalendarEvent.bind(client);
  client.createCalendarEvent = async (...args) => {
    const result = await realCreate(...args);
    if (result.isOk()) state.authorization = "unavailable";
    return result;
  };
  const service = makeService(client, state);
  const request = input();
  expect(unwrap(await service.organize(actor, request)).state).toBe("pending");
  state.authorization = "allowed";
  state.duplicate = true;
  expect(
    unwrap(await service.reconcile(actor, "default", request.requestId)).state,
  ).toBe("sent");
}, 120_000);

it("releases its pre-submit claim when sender authorization is temporarily unavailable", async () => {
  const state: SenderState = { authorization: "allowed", changed: false };
  const client = makeClient();
  let checks = 0;
  const service = makeService(client, state, () => {
    checks += 1;
    if (checks === 1) state.authorization = "unavailable";
    return Promise.resolve(true);
  });
  const request = input();
  expect(unwrap(await service.organize(actor, request)).state).toBe("pending");
  const pending = await db.organizedOperation.findUniqueOrThrow({
    where: { id: request.requestId },
    include: { series: true, deliveries: true },
  });
  expect(pending.deliveries[0]?.phase).toBe("prepared");
  expect(pending.series.pendingId).toBe(request.requestId);
  state.authorization = "allowed";
  expect(
    unwrap(await service.reconcile(actor, "default", request.requestId)).state,
  ).toBe("sent");
}, 120_000);

it("does not abandon an in-flight submission after alias revocation", async () => {
  const state: SenderState = { authorization: "allowed", changed: false };
  const client = makeClient();
  const submit = client.submit.bind(client);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let submissions = 0;
  client.submit = async (...args) => {
    submissions += 1;
    entered.resolve();
    await release.promise;
    unwrap(await submit(...args));
    return err({ kind: "network", message: "response lost" });
  };
  const service = makeService(client, state);
  const request = input();
  const initial = service.organize(actor, request);
  await entered.promise;
  state.authorization = "revoked";
  let during;
  try {
    during = unwrap(
      await service.reconcile(actor, "default", request.requestId),
    );
  } finally {
    release.resolve();
  }
  expect(during.state).toBe("pending");
  expect(unwrap(await initial).state).toBe("pending");
  const recovered = unwrap(
    await service.reconcile(actor, "default", request.requestId),
  );
  expect(recovered.state).toBe("sent");
  expect(submissions).toBe(1);
}, 120_000);
