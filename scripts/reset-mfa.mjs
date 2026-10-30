import { createDatabase } from "../packages/db/src/index.ts";
import { createHash } from "node:crypto";

const [email, extra] = process.argv.slice(2);
const url = process.env["DATABASE_URL"];
if (!email || extra || !url)
  throw new Error(
    "Usage: DATABASE_URL=... node scripts/reset-mfa.mjs USER_EMAIL",
  );

const database = createDatabase(url);
if (database.isErr()) throw new Error("Database configuration invalid");
const db = database.value;
try {
  await db.$transaction(async (tx) => {
    const user = await tx.user.findUnique({
      where: { email: email.toLowerCase() },
    });
    if (!user) throw new Error("Account not found");
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
