import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import type { Result } from "neverthrow";
import {
  createDatabase,
  createMailboxStore,
  createProvisioningStore,
  createSecretBox,
  type PrismaClient,
} from "../src/index.ts";

const run = promisify(execFile);
const container = `mailbox-binding-${randomUUID().slice(0, 8)}`;
const key = randomBytes(32).toString("hex");
let db: PrismaClient;
let disconnect = async () => {};
const value = <T, E>(result: Result<T, E>): T => {
  if (result.isErr()) throw new Error("Fixture database operation failed");
  return result.value;
};
async function ready(remaining: number): Promise<void> {
  try {
    await run("docker", ["exec", container, "pg_isready", "-U", "postgres"]);
  } catch (error) {
    if (!remaining) throw error;
    await new Promise((resolve) => setTimeout(resolve, 500));
    await ready(remaining - 1);
  }
}
async function migrate(url: string, remaining = 3): Promise<void> {
  try {
    await run(
      "pnpm",
      ["--filter", "@opensuite/db", "exec", "prisma", "migrate", "deploy"],
      { env: { ...process.env, DATABASE_URL: url }, maxBuffer: 4_000_000 },
    );
  } catch (error) {
    if (!remaining || !String(error).includes("database system is starting up"))
      throw error;
    await new Promise((resolve) => setTimeout(resolve, 500));
    await migrate(url, remaining - 1);
  }
}
beforeAll(async () => {
  await run("docker", [
    "run",
    "-d",
    "--name",
    container,
    "-e",
    "POSTGRES_PASSWORD=fixture-password",
    "-p",
    "127.0.0.1::5432",
    "postgres:18.6",
  ]);
  await ready(120);
  const port = /:(\d+)\s*$/.exec(
    (await run("docker", ["port", container, "5432"])).stdout,
  )?.[1];
  if (!port) throw new Error("Missing fixture PostgreSQL port");
  const url = `postgresql://postgres:fixture-password@127.0.0.1:${port}/postgres`;
  await migrate(url);
  db = value(createDatabase(url));
  disconnect = () => db.$disconnect();
}, 300_000);
afterAll(async () => {
  await disconnect();
  await run("docker", ["rm", "-fv", container]).catch(() => undefined);
}, 60_000);

async function owner(prefix: string) {
  const id = `${prefix}-${randomUUID()}`;
  await db.user.create({
    data: { id, email: `${id}@example.test`, name: prefix },
  });
  return id;
}
async function activate(
  userId: string,
  accountId: string,
  address: string,
  secret = "first-secret",
) {
  await db.mailboxProvision.upsert({
    where: { userId },
    create: { userId, accountId, state: "issuing" },
    update: { accountId, state: "issuing" },
  });
  const result = await value(createProvisioningStore(db, key)).activate(
    userId,
    { accountId, address },
    { id: `credential-${randomUUID()}`, secret },
  );
  if (result.isErr()) throw new Error("Fixture activation failed");
  return db.mailboxLink.findUniqueOrThrow({ where: { userId } });
}

describe("persisted mailbox linkage identity", () => {
  it("backfills distinct identities and retains a database default for later raw inserts", async () => {
    const migration = await readFile(
      new URL(
        "../prisma/migrations/20261110012000_mailbox_binding_identity/migration.sql",
        import.meta.url,
      ),
      "utf8",
    );
    const sql = `CREATE SCHEMA binding_backfill; CREATE TABLE binding_backfill."MailboxLink" ("userId" TEXT PRIMARY KEY); INSERT INTO binding_backfill."MailboxLink" VALUES ('alice'), ('bob'); SET search_path TO binding_backfill;\n${migration}`;
    await run("docker", [
      "exec",
      container,
      "psql",
      "-U",
      "postgres",
      "-v",
      "ON_ERROR_STOP=1",
      "-c",
      sql,
    ]);
    await db.$executeRaw`INSERT INTO binding_backfill."MailboxLink" ("userId") VALUES ('carol')`;
    const rows = z
      .array(z.object({ id: z.uuid() }))
      .parse(
        await db.$queryRaw`SELECT "bindingId"::text AS id FROM binding_backfill."MailboxLink"`,
      );
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map((row) => row.id)).size).toBe(3);
  });

  it("gives each Prisma createMany link a different default identity", async () => {
    const box = value(createSecretBox(key));
    const alice = await owner("bulk-alice");
    const bob = await owner("bulk-bob");
    await db.mailboxLink.createMany({
      data: [alice, bob].map((userId) => ({
        userId,
        accountId: `account-${userId}`,
        address: `${userId}@example.test`,
        credentialId: "fixture",
        secret: value(
          box.encrypt("fixture", { userId, id: `account-${userId}` }),
        ),
      })),
    });
    const rows = await db.mailboxLink.findMany({
      where: { userId: { in: [alice, bob] } },
      select: { bindingId: true },
    });
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => z.uuid().parse(row.bindingId))).size).toBe(
      2,
    );
  });

  it("preserves identity across credential rotation and an address change on the same account", async () => {
    const userId = await owner("rotation");
    const accountId = `account-${userId}`;
    const first = await activate(userId, accountId, `${userId}@example.test`);
    const changed = await activate(
      userId,
      accountId,
      `renamed-${userId}@example.test`,
      "rotated-secret",
    );
    expect(changed.bindingId).toBe(first.bindingId);
    expect(changed.credentialId).not.toBe(first.credentialId);
    const found = value(
      await value(createMailboxStore(db, key)).getForOwner(userId, "default"),
    );
    expect(found.bindingId).toBe(first.bindingId);
    expect(found.secret).toBe("rotated-secret");
  });

  it("renews identity for each replacement, including A to B to A", async () => {
    const userId = await owner("replacement");
    const address = `${userId}@example.test`;
    const first = await activate(userId, `a-${userId}`, address);
    const second = await activate(userId, `b-${userId}`, address);
    const third = await activate(userId, `a-${userId}`, address);
    expect(
      new Set([first.bindingId, second.bindingId, third.bindingId]).size,
    ).toBe(3);
  });

  it("renews identity after deleting and recreating the same linked account", async () => {
    const userId = await owner("recreated");
    const accountId = `account-${userId}`;
    const address = `${userId}@example.test`;
    const first = await activate(userId, accountId, address);
    await db.mailboxLink.delete({ where: { userId } });
    const second = await activate(userId, accountId, address);
    expect(second.bindingId).not.toBe(first.bindingId);
  });

  it("rolls back a replacement when a uniqueness failure aborts activation", async () => {
    const userId = await owner("rollback");
    const otherId = await owner("conflicting");
    const original = await activate(
      userId,
      `original-${userId}`,
      `${userId}@example.test`,
    );
    const other = await activate(
      otherId,
      `other-${otherId}`,
      `${otherId}@example.test`,
    );
    await db.mailboxProvision.update({
      where: { userId },
      data: { accountId: `new-${userId}`, state: "issuing" },
    });
    const result = await value(createProvisioningStore(db, key)).activate(
      userId,
      { accountId: `new-${userId}`, address: other.address },
      { id: "new", secret: "unused" },
    );
    expect(result.isErr()).toBe(true);
    const after = await db.mailboxLink.findUniqueOrThrow({ where: { userId } });
    expect(after.bindingId).toBe(original.bindingId);
    expect(after.accountId).toBe(original.accountId);
  });

  it("allows only one concurrent activation and isolates lookup ownership", async () => {
    const userId = await owner("concurrent");
    const accountId = `account-${userId}`;
    const address = `${userId}@example.test`;
    await db.mailboxProvision.create({
      data: { userId, accountId, state: "issuing" },
    });
    const store = value(createProvisioningStore(db, key));
    const results = await Promise.all([
      store.activate(
        userId,
        { accountId, address },
        { id: "one", secret: "first" },
      ),
      store.activate(
        userId,
        { accountId, address },
        { id: "two", secret: "second" },
      ),
    ]);
    expect(results.filter((result) => result.isOk())).toHaveLength(1);
    const mailbox = value(createMailboxStore(db, key));
    expect((await mailbox.getForOwner(userId, "foreign-account")).isErr()).toBe(
      true,
    );
    expect((await mailbox.getForOwner("foreign-user", accountId)).isErr()).toBe(
      true,
    );
    expect(
      value(await mailbox.getForOwner(userId, accountId)).bindingId,
    ).toBeTruthy();
  });
});
