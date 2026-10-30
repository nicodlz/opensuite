import { readFile } from "node:fs/promises";
import process from "node:process";
import { createDatabase } from "@opensuite/db";
import { z } from "zod";
import { loadApplicationDatabaseUrl, loadAuthConfig } from "./config.ts";
import { createAuthRuntime } from "./auth/runtime.ts";

const input = z
  .tuple([z.email(), z.string().min(1)])
  .safeParse(process.argv.slice(2));
if (!input.success) {
  process.stderr.write(
    "Usage: node apps/api/src/bootstrap.ts EMAIL PASSWORD_FILE\n",
  );
  process.exit(1);
}
const url = await loadApplicationDatabaseUrl(process.env);
const config = await loadAuthConfig(process.env);
if (url.isErr() || config.isErr())
  throw new Error("invalid server configuration");
const db = createDatabase(url.value);
if (db.isErr()) throw new Error("invalid database configuration");
try {
  const password = (await readFile(input.data[1], "utf8")).trim();
  if (password.length < 12)
    throw new Error("password must contain at least 12 characters");
  const runtime = createAuthRuntime(db.value, config.value);
  await runtime.bootstrap(input.data[0], password, input.data[0]);
  process.stdout.write("Administrator account provisioned and promoted.\n");
} finally {
  await db.value.$disconnect();
}
