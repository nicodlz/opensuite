import { err, errAsync, ok, ResultAsync } from "neverthrow";
import { z } from "zod";
import { createSecretBox } from "./secrets.ts";
import type { PrismaClient } from "./generated/index.js";

const Account = z.object({ accountId: z.string().min(1), address: z.email() });
const Credential = z.object({
  id: z.string().min(1),
  secret: z.string().min(1),
});
const failure = (): { kind: "unavailable"; message: string } => ({
  kind: "unavailable",
  message: "mailbox provisioning failed",
});

export const createProvisioningStore = (db: PrismaClient, key: unknown) => {
  const box = createSecretBox(key);
  if (box.isErr()) return err(box.error);
  return ok({
    markDisabled(userId: string, actorId: string) {
      return ResultAsync.fromPromise(
        db.$transaction(async (tx) => {
          await tx.user.update({
            where: { id: userId },
            data: { disabled: true },
          });
          await tx.session.deleteMany({ where: { userId } });
          await tx.mailboxLink.updateMany({
            where: { userId },
            data: { status: "disabling" },
          });
          await tx.auditEvent.create({
            data: {
              userId: actorId,
              action: "admin.account.disable",
              detail: { targetUserId: userId },
            },
          });
        }),
        failure,
      );
    },
    mailboxAccountId(userId: string) {
      return ResultAsync.fromPromise(
        db.user.findUniqueOrThrow({
          where: { id: userId },
          select: {
            mailboxProvision: { select: { accountId: true } },
            mailbox: { select: { accountId: true } },
          },
        }),
        failure,
      ).map(
        (row) =>
          row.mailboxProvision?.accountId ?? row.mailbox?.accountId ?? null,
      );
    },
    prepare(userId: string) {
      return ResultAsync.fromPromise(
        (async () => {
          await db.mailboxProvision.upsert({
            where: { userId },
            create: { userId },
            update: {},
          });
          const row = await db.user.findUniqueOrThrow({
            where: { id: userId },
            select: { disabled: true, mailbox: { select: { status: true } } },
          });
          return {
            disabled: row.disabled,
            active: row.mailbox?.status === "active",
          };
        })(),
        failure,
      );
    },
    beginIssuance(
      userId: string,
      account: { accountId: string; address: string },
    ) {
      const parsed = Account.safeParse(account);
      if (!parsed.success) return errAsync(failure());
      return ResultAsync.fromPromise(
        (async () => {
          const updated = await db.mailboxProvision.updateMany({
            where: {
              userId,
              user: { disabled: false },
              OR: [{ accountId: null }, { accountId: parsed.data.accountId }],
            },
            data: { ...parsed.data, state: "issuing" },
          });
          if (updated.count !== 1) throw new Error("mailbox state unavailable");
        })(),
        failure,
      );
    },
    activate(
      userId: string,
      account: { accountId: string; address: string },
      credential: { id: string; secret: string },
    ) {
      const parsed = Account.safeParse(account);
      const parsedCredential = Credential.safeParse(credential);
      if (!parsed.success || !parsedCredential.success)
        return errAsync(failure());
      const encrypted = box.value.encrypt(parsedCredential.data.secret, {
        userId,
        id: parsed.data.accountId,
      });
      if (encrypted.isErr()) return errAsync(failure());
      return ResultAsync.fromPromise(
        db.$transaction(async (tx) => {
          const user = await tx.user.findUniqueOrThrow({
            where: { id: userId },
            select: { disabled: true },
          });
          if (user.disabled) throw new Error("account disabled");
          const updated = await tx.mailboxProvision.updateMany({
            where: {
              userId,
              accountId: parsed.data.accountId,
              state: "issuing",
            },
            data: { state: "active" },
          });
          if (updated.count !== 1) throw new Error("mailbox state unavailable");
          await tx.mailboxLink.upsert({
            where: { userId },
            create: {
              userId,
              ...parsed.data,
              credentialId: parsedCredential.data.id,
              secret: encrypted.value,
            },
            update: {
              ...parsed.data,
              credentialId: parsedCredential.data.id,
              secret: encrypted.value,
              status: "active",
            },
          });
        }),
        failure,
      );
    },
  });
};
