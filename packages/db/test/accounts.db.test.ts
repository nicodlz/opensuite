// Readiness probes must run in order while the database starts.
/* oxlint-disable eslint/no-await-in-loop */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  createAccountStore,
  createDatabase,
  type PrismaClient,
} from "../src/index.ts";

const run = promisify(execFile);
const container = `accounts-db-${randomUUID().slice(0, 8)}`;
let db: PrismaClient;
let url = "";
beforeAll(async () => {
  await run("docker", [
    "run",
    "-d",
    "--name",
    container,
    "-e",
    "POSTGRES_PASSWORD=test-password",
    "-e",
    "POSTGRES_INITDB_ARGS=--no-sync",
    "-p",
    "127.0.0.1::5432",
    "postgres:18.6",
  ]);
  for (let attempt = 0; ; attempt += 1) {
    try {
      await run("docker", ["exec", container, "pg_isready", "-U", "postgres"]);
      break;
    } catch (error) {
      if (attempt >= 240) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  const port = /:(\d+)\s*$/.exec(
    (await run("docker", ["port", container, "5432"])).stdout,
  )?.[1];
  if (!port) throw new Error("Missing test database port");
  url = `postgresql://postgres:test-password@127.0.0.1:${port}/postgres`;
  for (let attempt = 0; ; attempt += 1) {
    try {
      await run(
        "pnpm",
        ["--filter", "@opensuite/db", "exec", "prisma", "migrate", "deploy"],
        { env: { ...process.env, DATABASE_URL: url }, maxBuffer: 4_000_000 },
      );
      break;
    } catch (error) {
      if (
        attempt >= 5 ||
        !String(error).includes("database system is starting up")
      )
        throw error;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  const result = createDatabase(url);
  if (result.isErr()) throw new Error(result.error.message);
  db = result.value;
}, 300_000);
afterAll(async () => {
  // The setup hook can fail before the client is assigned.
  // oxlint-disable-next-line typescript/no-unnecessary-condition
  await db?.$disconnect();
  await run("docker", ["rm", "-fv", container]).catch(() => undefined);
}, 60_000);

it("finds only enabled accounts by sign-in address, ignoring case", async () => {
  const accounts = createAccountStore(db);
  await db.user.createMany({
    data: [
      { id: "ada", email: "ada@example.test", name: "Ada" },
      {
        id: "bert",
        email: "bert@example.test",
        name: "Bert",
        disabled: true,
      },
    ],
  });
  const found = await accounts.enabledUserIdForEmail("Ada@Example.TEST");
  const disabled = await accounts.enabledUserIdForEmail("bert@example.test");
  const unknown = await accounts.enabledUserIdForEmail("other@example.test");
  expect(found.isOk() && found.value).toBe("ada");
  expect(disabled.isOk() && disabled.value).toBeNull();
  expect(unknown.isOk() && unknown.value).toBeNull();

  const emails = await accounts.enabledEmails(["ada", "bert", "gone"]);
  expect(emails.isOk() && emails.value).toEqual([
    { userId: "ada", address: "ada@example.test" },
  ]);
  const none = await accounts.enabledEmails([]);
  expect(none.isOk() && none.value).toEqual([]);
});

it("reports a database failure instead of no account", async () => {
  const closed = createDatabase(url.replace(/:\d+\//, ":1/"));
  if (closed.isErr()) throw new Error(closed.error.message);
  const accounts = createAccountStore(closed.value);
  try {
    const resolved = await accounts.enabledUserIdForEmail("ada@example.test");
    const listed = await accounts.enabledEmails(["ada"]);
    expect(resolved.isErr() && resolved.error.kind).toBe("unavailable");
    expect(listed.isErr() && listed.error.kind).toBe("unavailable");
  } finally {
    await closed.value.$disconnect();
  }
}, 60_000);
