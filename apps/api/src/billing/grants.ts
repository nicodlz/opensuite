import type { PrismaClient } from "@opensuite/db";
import { z } from "zod";

const GrantInput = z.object({
  email: z.email().transform((value) => value.toLowerCase()),
  plan: z.enum(["plus", "pro", "unlimited"]),
  reason: z.string().trim().min(1).max(500),
  expiresAt: z.date().nullable(),
});
export const createGrantStore = (db: PrismaClient) => ({
  async grant(input: z.input<typeof GrantInput>) {
    const data = GrantInput.parse(input);
    if (data.expiresAt !== null && data.expiresAt <= new Date())
      throw new Error("Grant expiry must be in the future");
    return db.$transaction(async (tx) => {
      const user = await tx.user.findFirst({
        where: { email: { equals: data.email, mode: "insensitive" } },
        select: { id: true, email: true },
      });
      if (user === null) throw new Error("Account not found");
      const grant = await tx.billingGrant.upsert({
        where: { userId: user.id },
        create: {
          userId: user.id,
          plan: data.plan,
          reason: data.reason,
          expiresAt: data.expiresAt,
        },
        update: {
          plan: data.plan,
          reason: data.reason,
          expiresAt: data.expiresAt,
          grantedAt: new Date(),
          revokedAt: null,
        },
      });
      await tx.auditEvent.create({
        data: {
          userId: user.id,
          action: "billing.grant.create",
          detail: {
            plan: data.plan,
            reason: data.reason,
            expiresAt: data.expiresAt?.toISOString() ?? null,
          },
        },
      });
      return { user, grant };
    });
  },
  async revoke(email: string, reason: string) {
    const normalized = z.email().parse(email).toLowerCase();
    const why = z.string().trim().min(1).max(500).parse(reason);
    return db.$transaction(async (tx) => {
      const user = await tx.user.findFirst({
        where: { email: { equals: normalized, mode: "insensitive" } },
        select: { id: true, email: true },
      });
      if (user === null) throw new Error("Account not found");
      const result = await tx.billingGrant.updateMany({
        where: { userId: user.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      if (result.count !== 1) throw new Error("Active grant not found");
      await tx.auditEvent.create({
        data: {
          userId: user.id,
          action: "billing.grant.revoke",
          detail: { reason: why },
        },
      });
      return user;
    });
  },
  async list() {
    return db.$transaction(async (tx) => {
      const grants = await tx.billingGrant.findMany({
        include: { user: { select: { email: true } } },
        orderBy: { grantedAt: "desc" },
      });
      await tx.auditEvent.create({
        data: { userId: null, action: "billing.grant.list", detail: {} },
      });
      return grants;
    });
  },
});
