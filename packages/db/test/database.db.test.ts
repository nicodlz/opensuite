import { execFile } from "node:child_process";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  createDatabase,
  createDatabaseProbe,
  createMailboxStore,
  createProviderStore,
  createSecretBox,
  loadDatabaseConfig,
} from "../src/index.ts";
import type { PrismaClient } from "../src/generated/index.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const run = promisify(execFile);
const inputRunId = process.env[["CLE", "ITO_RUN_ID"].join("")] ?? "local";
const runId =
  inputRunId
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .slice(0, 30) || "local";
const project = `opensuite-db-${runId}-${randomUUID().slice(0, 8)}`;
const composeArgs = [
  "compose",
  "--project-name",
  project,
  "--env-file",
  "deploy/env.example",
  "--file",
  "compose.yaml",
  "--file",
  "compose.test.yaml",
];
const compose = async (...args: string[]) =>
  (
    await run("docker", [...composeArgs, ...args], {
      cwd: root,
      maxBuffer: 16 * 1024 * 1024,
    })
  ).stdout;
const cleanup = async () => {
  await compose("down", "--volumes", "--remove-orphans", "--timeout", "10");
};
const key = randomBytes(32).toString("hex");
let db: PrismaClient;
let databaseUrl = "";
let disconnect = () => Promise.resolve();

beforeAll(async () => {
  try {
    await compose(
      "up",
      "--detach",
      "--wait",
      "--wait-timeout",
      "120",
      "postgres",
    );
    await compose("run", "--build", "--rm", "--no-deps", "migrate");
    const portOutput = await compose("port", "postgres", "5432");
    const port = /:(\d+)\s*$/.exec(portOutput)?.[1];
    if (port === undefined) throw new Error("PostgreSQL host port missing");
    const password = (
      await compose(
        "exec",
        "-T",
        "postgres",
        "cat",
        "/run/opensuite/postgres/password",
      )
    ).trim();
    const url = new URL("postgresql://127.0.0.1/opensuite");
    url.port = port;
    url.username = "opensuite";
    url.password = password;
    databaseUrl = url.toString();
    const result = createDatabase(url.toString());
    if (result.isErr()) throw new Error(result.error.message);
    db = result.value;
    disconnect = () => db.$disconnect();
    await db.$connect();
  } catch (error) {
    await cleanup();
    throw error;
  }
}, 600_000);

afterAll(async () => {
  try {
    await disconnect();
  } finally {
    await cleanup();
  }
}, 60_000);

describe("PostgreSQL schema and adapters", () => {
  it("has no Prisma schema drift after migrations", async () => {
    const result = await run(
      "pnpm",
      [
        "--filter",
        "@opensuite/db",
        "exec",
        "prisma",
        "migrate",
        "diff",
        "--from-schema-datasource",
        "prisma/schema.prisma",
        "--to-schema-datamodel",
        "prisma/schema.prisma",
        "--exit-code",
      ],
      {
        cwd: root,
        env: { ...process.env, DATABASE_URL: databaseUrl },
        maxBuffer: 4_000_000,
      },
    );
    expect(result.stdout).toContain("No difference detected");
  }, 60_000);
  it("enforces case-insensitive names and routes addresses belonging to another user", async () => {
    const owner = `domain-owner-${randomUUID()}`;
    const target = `domain-target-${randomUUID()}`;
    await db.user.createMany({
      data: [
        { id: owner, email: `${owner}@example.test`, name: "Owner" },
        { id: target, email: `${target}@example.test`, name: "Target" },
      ],
    });
    const name = `${randomUUID()}.example.test`;
    const domain = await db.domain.create({ data: { name, userId: owner } });
    await expect(
      db.domain.create({ data: { name: name.toUpperCase(), userId: owner } }),
    ).rejects.toThrow("Unique constraint");
    await db.address.create({
      data: {
        domainId: domain.id,
        userId: target,
        localPart: "Sales",
        isAlias: true,
      },
    });
    await expect(
      db.address.create({
        data: {
          domainId: domain.id,
          userId: target,
          localPart: "sales",
          isAlias: true,
        },
      }),
    ).rejects.toThrow("Unique constraint");
  });
  it("encrypts a mailbox credential and restricts lookup to its owner", async () => {
    const storeResult = createMailboxStore(db, key);
    if (storeResult.isErr()) throw new Error(storeResult.error.message);
    const store = storeResult.value;
    const owner = `mail-owner-${randomUUID()}`;
    const other = `mail-other-${randomUUID()}`;
    await db.user.createMany({
      data: [
        { id: owner, email: `${owner}@example.test`, name: "Owner" },
        { id: other, email: `${other}@example.test`, name: "Other" },
      ],
    });
    const accountId = `mail-${randomUUID()}`;
    const secret = "one-time-application-password";
    expect(
      (
        await store.create({
          userId: owner,
          accountId,
          address: `${owner}@example.test`,
          credentialId: "credential",
          secret,
        })
      ).isOk(),
    ).toBe(true);
    const row = await db.mailboxLink.findUniqueOrThrow({
      where: { userId: owner },
    });
    expect(row.secret).not.toContain(secret);
    const owned = await store.getForOwner(owner, accountId);
    expect(owned.isOk() ? owned.value.secret : undefined).toBe(secret);
    expect((await store.getForOwner(other, accountId)).isErr()).toBe(true);
    await db.user.update({ where: { id: owner }, data: { disabled: true } });
    expect((await store.getForOwner(owner, accountId)).isErr()).toBe(true);
  });
  it("applies migrations from an empty database and records their checksums", async () => {
    const rows = z
      .array(
        z.object({
          migration_name: z.string(),
          checksum: z.string(),
          finished_at: z.date().nullable(),
        }),
      )
      .parse(
        await db.$queryRaw`SELECT migration_name, checksum, finished_at FROM "_prisma_migrations"`,
      );
    const migrations = await readdir(
      new URL("../prisma/migrations", import.meta.url),
      { withFileTypes: true },
    );
    expect(rows.map((row) => row.migration_name).toSorted()).toEqual(
      migrations
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .toSorted(),
    );
    const migration = rows.find(
      (row) => row.migration_name === "20261029000000_initial",
    );
    expect(migration?.migration_name).toBe("20261029000000_initial");
    expect(migration?.finished_at).not.toBeNull();
    const sql = await readFile(
      new URL(
        "../prisma/migrations/20261029000000_initial/migration.sql",
        import.meta.url,
      ),
    );
    expect(migration?.checksum).toBe(
      createHash("sha256").update(sql).digest("hex"),
    );
    const tables = z
      .array(z.object({ table_name: z.string() }))
      .parse(
        await db.$queryRaw`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`,
      );
    expect(tables.map((row) => row.table_name)).toEqual(
      expect.arrayContaining([
        "User",
        "Session",
        "Account",
        "Verification",
        "Domain",
        "Address",
        "ProviderConfig",
        "IngestionRecord",
        "AuditEvent",
      ]),
    );
  });

  it("refuses changed migration history before deploying", async () => {
    const rows = z
      .array(z.object({ checksum: z.string() }))
      .length(1)
      .parse(
        await db.$queryRaw`SELECT checksum FROM "_prisma_migrations" WHERE migration_name = '20261029000000_initial'`,
      );
    const checksum = rows[0]?.checksum;
    if (checksum === undefined) throw new Error("migration missing");
    await db.$executeRaw`UPDATE "_prisma_migrations" SET checksum = 'changed' WHERE migration_name = '20261029000000_initial'`;
    try {
      await expect(
        compose("run", "--rm", "--no-deps", "migrate"),
      ).rejects.toThrow(/Command failed/);
    } finally {
      await db.$executeRaw`UPDATE "_prisma_migrations" SET checksum = ${checksum} WHERE migration_name = '20261029000000_initial'`;
    }
    await expect(
      compose(
        "run",
        "--rm",
        "--no-deps",
        "--user",
        "0",
        "--entrypoint",
        "sh",
        "migrate",
        "-c",
        "printf '\\n-- altered\\n' >> prisma/migrations/20261029000000_initial/migration.sql; node src/migrate.ts",
      ),
    ).rejects.toThrow(/Database migration failed/);
    await expect(
      compose("run", "--rm", "--no-deps", "migrate"),
    ).resolves.toContain("No pending migrations");
  }, 60_000);

  it("enforces identity, address, provider and ingestion uniqueness", async () => {
    await db.user.createMany({
      data: [
        {
          id: "user-a",
          name: "A",
          email: "a@example.test",
          updatedAt: new Date(),
        },
        {
          id: "user-b",
          name: "B",
          email: "b@example.test",
          updatedAt: new Date(),
        },
      ],
    });
    await expect(
      db.user.create({
        data: { id: "user-c", name: "C", email: "a@example.test" },
      }),
    ).rejects.toThrow(/Unique constraint/);
    await db.session.create({
      data: {
        id: "session-a",
        userId: "user-a",
        token: "token",
        expiresAt: new Date(),
      },
    });
    await expect(
      db.session.create({
        data: {
          id: "session-b",
          userId: "user-b",
          token: "token",
          expiresAt: new Date(),
        },
      }),
    ).rejects.toThrow(/Unique constraint/);
    await db.account.create({
      data: {
        id: "auth-a",
        userId: "user-a",
        accountId: "external",
        providerId: "credential",
      },
    });
    await expect(
      db.account.create({
        data: {
          id: "auth-b",
          userId: "user-b",
          accountId: "external",
          providerId: "credential",
        },
      }),
    ).rejects.toThrow(/Unique constraint/);
    await db.domain.create({
      data: { id: "domain-a", userId: "user-a", name: "example.test" },
    });
    await expect(
      db.domain.create({
        data: { id: "domain-b", userId: "user-b", name: "example.test" },
      }),
    ).rejects.toThrow(/Unique constraint/);
    await db.address.create({
      data: { userId: "user-a", domainId: "domain-a", localPart: "inbox" },
    });
    await expect(
      db.address.create({
        data: {
          userId: "user-a",
          domainId: "domain-a",
          localPart: "inbox",
          isAlias: true,
        },
      }),
    ).rejects.toThrow(/Unique constraint/);
    await db.ingestionRecord.create({
      data: { userId: "user-a", idempotencyKey: "event-1" },
    });
    await expect(
      db.ingestionRecord.create({
        data: { userId: "user-b", idempotencyKey: "event-1" },
      }),
    ).rejects.toThrow(/Unique constraint/);
  });

  it("scopes provider lookups to their owner", async () => {
    const storeResult = createProviderStore(db, key);
    if (storeResult.isErr()) throw new Error(storeResult.error.message);
    const store = storeResult.value;
    const created = await store.create({
      userId: "user-a",
      name: "smtp",
      secret: "my secret",
    });
    if (created.isErr()) throw new Error(created.error.message);
    await expect(
      db.providerConfig.create({
        data: { userId: "user-a", name: "unsafe", secret: "plaintext" },
      }),
    ).rejects.toThrow(/provider_secret_envelope/);
    const stored = await db.providerConfig.findUniqueOrThrow({
      where: { id: created.value.id },
    });
    expect(stored.secret).not.toContain("my secret");
    const own = await store.get({ userId: "user-a", id: created.value.id });
    expect(own.isOk() && own.value.secret).toBe("my secret");
    const other = await store.get({ userId: "user-b", id: created.value.id });
    expect(other.isErr() && other.error.kind).toBe("not_found");
    const parts = stored.secret.split(".");
    const cipher = parts[2];
    if (cipher === undefined) throw new Error("ciphertext missing");
    parts[2] = `${cipher[0] === "A" ? "B" : "A"}${cipher.slice(1)}`;
    await db.providerConfig.update({
      where: { id: created.value.id },
      data: { secret: parts.join(".") },
    });
    const tampered = await store.get({
      userId: "user-a",
      id: created.value.id,
    });
    expect(tampered.isErr() && tampered.error.kind).toBe("crypto_error");
    const duplicate = await store.create({
      userId: "user-a",
      name: "smtp",
      secret: "another",
    });
    expect(duplicate.isErr() && duplicate.error.kind).toBe("conflict");
    const missingOwner = await store.create({
      userId: "missing",
      name: "smtp",
      secret: "another",
    });
    expect(missingOwner.isErr() && missingOwner.error.kind).toBe(
      "database_error",
    );
  });

  it("authenticates encrypted secrets and rejects tampering and wrong context", () => {
    const result = createSecretBox(key);
    if (result.isErr()) throw new Error(result.error.message);
    const box = result.value;
    const encrypted = box.encrypt("sensitive value", {
      userId: "user-a",
      id: "one",
    });
    if (encrypted.isErr()) throw new Error(encrypted.error.message);
    const decrypted = box.decrypt(encrypted.value, {
      userId: "user-a",
      id: "one",
    });
    expect(decrypted.isOk() && decrypted.value).toBe("sensitive value");
    const pieces = encrypted.value.split(".");
    const ciphertext = pieces[2];
    if (ciphertext === undefined) throw new Error("ciphertext missing");
    pieces[2] = `${ciphertext[0] === "A" ? "B" : "A"}${ciphertext.slice(1)}`;
    expect(
      box.decrypt(pieces.join("."), { userId: "user-a", id: "one" }).isErr(),
    ).toBe(true);
    expect(
      box.decrypt(encrypted.value, { userId: "user-b", id: "one" }).isErr(),
    ).toBe(true);
    expect(createSecretBox("invalid").isErr()).toBe(true);
    expect(createDatabase("invalid").isErr()).toBe(true);
    expect(
      loadDatabaseConfig({
        DATABASE_URL: "invalid",
        PROVIDER_ENCRYPTION_KEY: key,
      }).isErr(),
    ).toBe(true);
    expect(
      loadDatabaseConfig({
        DATABASE_URL: "postgresql://localhost/db",
        PROVIDER_ENCRYPTION_KEY: "invalid",
      }).isErr(),
    ).toBe(true);
  });

  it("rejects updates, deletes and truncation of audit entries", async () => {
    const event = await db.auditEvent.create({
      data: { userId: "user-a", action: "created", detail: { ok: true } },
    });
    await expect(
      db.auditEvent.update({
        where: { id: event.id },
        data: { action: "changed" },
      }),
    ).rejects.toThrow(/audit log is append-only/);
    await expect(
      db.auditEvent.delete({ where: { id: event.id } }),
    ).rejects.toThrow(/audit log is append-only/);
    await expect(db.$executeRaw`TRUNCATE TABLE "AuditEvent"`).rejects.toThrow(
      /audit log is append-only/,
    );
    expect(await db.auditEvent.count({ where: { id: event.id } })).toBe(1);
  });

  it("reports database readiness, failures, and an aborted probe", async () => {
    const probe = createDatabaseProbe(db);
    expect((await probe.check(new AbortController().signal)).isOk()).toBe(true);
    const abort = new AbortController();
    abort.abort();
    const result = await probe.check(abort.signal);
    expect(result.isErr() && result.error.kind).toBe("timeout");
    const unavailable = createDatabase(
      "postgresql://nobody:secret@127.0.0.1:1/missing?connect_timeout=1",
    );
    if (unavailable.isErr()) throw new Error(unavailable.error.message);
    try {
      const failure = await createDatabaseProbe(unavailable.value).check(
        AbortSignal.timeout(5_000),
      );
      expect(failure.isErr() && failure.error).toEqual({
        kind: "unavailable",
        message: "database query failed",
      });
    } finally {
      await unavailable.value.$disconnect();
    }
  });
});

describe("alias reservations", () => {
  it("keeps a mailbox's primary address from other users and its domain from removal", async () => {
    const suffix = randomUUID();
    const owner = `primary-owner-${suffix}`;
    const other = `primary-other-${suffix}`;
    const name = `${suffix}.example.test`;
    await db.user.createMany({
      data: [
        { id: owner, email: `owner@${name}`, name: owner },
        { id: other, email: `other@${name}`, name: other },
        // Signed up, still waiting for its mailbox.
        { id: `pending-${suffix}`, email: `pending@${name}`, name: "Pending" },
      ],
    });
    const domain = await db.domain.create({
      data: { name, userId: owner, status: "verified", stalwartId: "d" },
    });
    await db.mailboxLink.createMany({
      data: [owner, other].map((userId, index) => ({
        userId,
        accountId: `${suffix}-${String(index)}`,
        address: `${index === 0 ? "owner" : "other"}@${name}`,
        credentialId: "fixture",
        secret: "v1.AAAAAAAAAAAAAAAA.A.AAAAAAAAAAAAAAAAAAAAAA",
      })),
    });
    const { createAliasStore, createDomainStore } =
      await import("../src/index.ts");
    const domains = createDomainStore(db);
    const removal = await domains.beginRemoval(domain.id);
    expect(removal.isOk() && removal.value).toBe(false);
    // So does a domain whose only account is still waiting for its mailbox.
    const waiting = `waiting-${suffix}.example.test`;
    await db.user.create({
      data: { id: `waiting-${suffix}`, email: `w@${waiting}`, name: "W" },
    });
    const quiet = await db.domain.create({
      data: { name: waiting, userId: owner, status: "verified" },
    });
    const blocked = await domains.beginRemoval(quiet.id);
    expect(blocked.isOk() && blocked.value).toBe(false);
    expect(
      (
        await domains.addAddress(owner, domain.id, other, "OWNER", false)
      ).isErr(),
    ).toBe(true);
    const alias = await createAliasStore(db).reserve(
      other,
      { domainId: domain.id },
      "owner",
      10,
    );
    expect(alias.isErr() && alias.error).toEqual({ kind: "conflict" });
    expect(
      (
        await domains.addAddress(owner, domain.id, other, "pending", false)
      ).isErr(),
    ).toBe(true);
    const early = await createAliasStore(db).reserve(
      other,
      { domainId: domain.id },
      "pending",
      10,
    );
    expect(early.isErr() && early.error).toEqual({ kind: "conflict" });
    expect(await db.address.count({ where: { domainId: domain.id } })).toBe(0);
    expect(
      (
        await domains.addAddress(owner, domain.id, owner, "owner", false)
      ).isOk(),
    ).toBe(true);
  });

  it("reserves deleted addresses permanently and routes only active aliases", async () => {
    const suffix = randomUUID();
    const owner = `alias-owner-${suffix}`;
    const other = `alias-other-${suffix}`;
    await db.user.createMany({
      data: [
        { id: owner, email: `${owner}@example.test`, name: owner },
        { id: other, email: `${other}@example.test`, name: other },
      ],
    });
    const domain = await db.domain.create({
      data: {
        name: `${suffix}.example.test`,
        userId: owner,
        status: "verified",
      },
    });
    const { createDomainStore } = await import("../src/index.ts");
    const store = createDomainStore(db);
    await db.user.update({
      where: { id: other },
      data: { defaultAliasDomainId: domain.id },
    });
    const blocked = await store.beginRemoval(domain.id);
    expect(blocked.isOk() && blocked.value).toBe(false);
    expect(
      (await db.domain.findUniqueOrThrow({ where: { id: domain.id } }))
        .removalPending,
    ).toBe(false);
    await db.user.update({
      where: { id: other },
      data: { defaultAliasDomainId: null },
    });
    await db.mailboxLink.create({
      data: {
        userId: owner,
        accountId: suffix,
        address: `${owner}@example.test`,
        credentialId: "fixture",
        secret: "v1.AAAAAAAAAAAAAAAA.A.AAAAAAAAAAAAAAAAAAAAAA",
      },
    });
    const address = await db.address.create({
      data: {
        userId: owner,
        domainId: domain.id,
        localPart: "private",
        isAlias: true,
      },
    });
    const full = `private@${domain.name}`;
    const alias = await db.emailAlias.create({
      data: {
        userId: owner,
        domainId: domain.id,
        addressId: address.id,
        address: full,
        localPart: "private",
        ready: true,
      },
    });
    const active = await store.routes([full]);
    expect(active.isOk() && active.value).toEqual([
      { address: full, destination: suffix },
    ]);
    await db.emailAlias.update({
      where: { id: alias.id },
      data: { enabled: false, deletedAt: new Date() },
    });
    const inactive = await store.routes([full]);
    expect(inactive.isOk() && inactive.value).toEqual([]);
    const tombstoneBlocked = await store.beginRemoval(domain.id);
    expect(tombstoneBlocked.isOk() && tombstoneBlocked.value).toBe(false);
    await expect(
      db.address.delete({ where: { id: address.id } }),
    ).rejects.toThrow("EmailAlias_addressId_fkey");
    await expect(
      db.address.create({
        data: {
          userId: other,
          domainId: domain.id,
          localPart: "PRIVATE",
          isAlias: true,
        },
      }),
    ).rejects.toThrow("Unique constraint");
  });
});
