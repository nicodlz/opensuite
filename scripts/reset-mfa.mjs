import { createDatabase } from "../packages/db/src/index.ts";
import { createHash } from "node:crypto";
import { loadApplicationDatabaseUrl } from "../apps/api/src/config.ts";

const [email, flag, confirm, extra] = process.argv.slice(2);
let configured = process.env["DATABASE_URL"];
if (!configured) {
  const loaded = await loadApplicationDatabaseUrl(process.env);
  if (loaded.isErr()) throw new Error("Database configuration invalid");
  configured = loaded.value;
}
if (
  !email ||
  extra ||
  (flag !== undefined && (flag !== "--confirm" || !confirm))
)
  throw new Error(
    "Usage: node scripts/reset-mfa.mjs USER_EMAIL [--confirm USER_ID]",
  );

const database = createDatabase(configured);
if (database.isErr()) throw new Error("Database configuration invalid");
const db = database.value;
try {
  const target = await db.user.findUnique({
    where: { email: email.toLowerCase() },
    select: { id: true, email: true },
  });
  if (!target) throw new Error("Account not found");
  process.stdout.write(`Target: ${target.email} (${target.id})\n`);
  if (confirm !== target.id)
    throw new Error(
      "No reset performed; repeat with --confirm and the target user ID",
    );
  await db.$transaction(async (tx) => {
    const user = await tx.user.findUnique({
      where: { email: email.toLowerCase() },
    });
    if (!user) throw new Error("Account not found");
    if (user.id !== confirm)
      throw new Error("Account changed; no reset performed");
    await tx.session.deleteMany({ where: { userId: user.id } });
    const challenges = await tx.verification.findMany({
      where: { value: user.id, identifier: { startsWith: "2fa-" } },
      select: { identifier: true },
    });
    const related = challenges.flatMap(({ identifier }) => [
      `2fa-attempts-${identifier}`,
      `key-auth-${createHash("sha256").update(identifier).digest("hex")}`,
    ]);
    await tx.verification.deleteMany({
      where: { identifier: { in: related } },
    });
    await tx.verification.deleteMany({
      where: {
        identifier: { startsWith: "key-register-" },
        value: { startsWith: `{"userId":${JSON.stringify(user.id)},` },
      },
    });
    // Includes pending second-factor challenges and trusted-device records.
    await tx.verification.deleteMany({ where: { value: user.id } });
    await tx.twoFactor.deleteMany({ where: { userId: user.id } });
    await tx.securityKey.deleteMany({ where: { userId: user.id } });
    await tx.user.update({
      where: { id: user.id },
      data: { twoFactorEnabled: false },
    });
    await tx.auditEvent.create({
      data: {
        userId: user.id,
        action: "mfa.operator_reset.success",
        detail: {},
      },
    });
  });
  process.stdout.write("MFA reset; sessions and pending challenges revoked.\n");
} finally {
  await db.$disconnect();
}
