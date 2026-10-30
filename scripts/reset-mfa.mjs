import { createDatabase } from "../packages/db/src/index.ts";

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
    // Includes pending second-factor challenges and trusted-device records.
    await tx.verification.deleteMany({ where: { value: user.id } });
    await tx.twoFactor.deleteMany({ where: { userId: user.id } });
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
