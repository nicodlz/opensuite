import { readFile } from "node:fs/promises";
import process from "node:process";
import { createDatabase } from "@opensuite/db";
import { z } from "zod";
import { createGrantStore } from "./billing/grants.ts";

const usage =
  "Usage: node apps/api/src/billing-grant.ts EMAIL --plan plus|pro|unlimited [--expires DATE] --reason TEXT | EMAIL --revoke [--reason TEXT] | --list";
const args = process.argv.slice(2);
const list = args.length === 1 && args[0] === "--list";
if (list) args.length = 0;
const email = list ? undefined : args.shift();
const flags = new Map<string, string | boolean>();
while (args.length > 0) {
  const flag = args.shift();
  if (
    flag === undefined ||
    !["--plan", "--expires", "--reason", "--revoke"].includes(flag) ||
    flags.has(flag)
  )
    throw new Error(usage);
  if (flag === "--revoke") flags.set(flag, true);
  else {
    const value = args.shift();
    if (value === undefined || value.startsWith("--")) throw new Error(usage);
    flags.set(flag, value);
  }
}
const databaseUrl = process.env["DATABASE_URL"];
if (!databaseUrl)
  throw new Error("DATABASE_URL for the operator database role is required");
const result = createDatabase(databaseUrl);
if (result.isErr()) throw new Error("Invalid database configuration");
const db = result.value;
const store = createGrantStore(db);
try {
  if (list) {
    const grants = await store.list();
    for (const grant of grants)
      process.stdout.write(`${JSON.stringify(grant)}\n`);
  } else {
    if (email === undefined || !z.email().safeParse(email).success)
      throw new Error(usage);
    let userId: string;
    if (flags.has("--revoke")) {
      if (flags.has("--plan") || flags.has("--expires")) throw new Error(usage);
      const user = await store.revoke(
        email,
        z.string().parse(flags.get("--reason") ?? "operator revoked"),
      );
      userId = user.id;
      process.stdout.write(`Revoked grant for ${user.email}\n`);
    } else {
      const plan = z
        .enum(["plus", "pro", "unlimited"])
        .parse(flags.get("--plan"));
      const reason = z.string().parse(flags.get("--reason"));
      const expiry = flags.get("--expires");
      const expiresAt =
        expiry === undefined ? null : z.coerce.date().parse(expiry);
      const granted = await store.grant({ email, plan, reason, expiresAt });
      userId = granted.user.id;
      process.stdout.write(`Granted ${plan} to ${granted.user.email}\n`);
    }
    const origin = process.env["BILLING_INTERNAL_API"];
    const tokenFile = process.env["BILLING_INTERNAL_TOKEN_FILE"];
    if (origin && tokenFile) {
      try {
        const token = (await readFile(tokenFile, "utf8")).trim();
        const response = await fetch(
          new URL(
            `/internal/storage/${encodeURIComponent(userId)}/refresh`,
            origin,
          ),
          {
            method: "POST",
            headers: { authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(5000),
            redirect: "error",
          },
        );
        if (!response.ok) throw new Error("refresh unavailable");
      } catch {
        process.stderr.write(
          "Mail quota refresh deferred to the periodic job\n",
        );
      }
    }
  }
} finally {
  await db.$disconnect();
}
