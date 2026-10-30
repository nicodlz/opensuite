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
    user(userId: string) {
      return ResultAsync.fromPromise(
        db.user.findUniqueOrThrow({
          where: { id: userId },
          select: { email: true },
        }),
        failure,
      );
    },
    pending() {
      return ResultAsync.fromPromise(
        db.user.findMany({
          where: {
            OR: [
              {
                disabled: false,
                OR: [
                  { mailbox: null },
                  { mailbox: { status: { not: "active" } } },
                ],
              },
              {
                disabled: true,
                OR: [
                  { mailbox: { status: "disabling" } },
                  { mailboxProvision: { state: { not: "active" } } },
                ],
              },
            ],
          },
          select: { id: true, disabled: true },
        }),
        failure,
      );
    },
    userForAccount(accountId: string) {
      return ResultAsync.fromPromise(
        db.mailboxProvision.findFirst({
          where: { accountId },
          select: { userId: true },
        }),
        failure,
      ).map((row) => row?.userId ?? null);
    },
    sessionAllowed(userId: string) {
      return ResultAsync.fromPromise(
        db.user.count({
          where: { id: userId, disabled: false, mailbox: { status: "active" } },
        }),
        failure,
      ).map((count) => count === 1);
    },
    finishDisabled(userId: string) {
      return ResultAsync.fromPromise(
        db.$transaction(async (tx) => {
          await tx.mailboxLink.updateMany({
            where: { userId },
            data: { status: "disabled" },
          });
          await tx.mailboxProvision.updateMany({
            where: { userId },
            data: { state: "active" },
          });
        }),
        failure,
      );
    },
    markDisabled(userId: string, actorId: string) {
      return ResultAsync.fromPromise(
        db.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT pg_advisory_xact_lock(1984327101)::text`;
          const actor = await tx.user.findFirst({
            where: { id: actorId, role: "admin", disabled: false },
            select: { id: true },
          });
          const target = await tx.user.findUnique({
            where: { id: userId },
            select: { id: true, role: true, disabled: true },
          });
          if (
            actor === null ||
            target === null ||
            userId === actorId ||
            (target.role === "admin" &&
              !target.disabled &&
              (await tx.user.count({
                where: { role: "admin", disabled: false },
              })) <= 1)
          )
            return false;
          await tx.mailboxProvision.upsert({
            where: { userId },
            create: { userId },
            update: { state: "pending" },
          });
          await tx.user.update({
            where: { id: userId },
            data: { disabled: true },
          });
          await tx.address.updateMany({
            where: {
              mailboxManaged: true,
              OR: [{ userId }, { domain: { userId } }],
            },
            data: { ready: false, revision: { increment: 1 } },
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
          return true;
        }),
        failure,
      ).andThen((allowed) =>
        allowed
          ? ok(undefined)
          : err<never, { kind: "forbidden"; message: string }>({
              kind: "forbidden",
              message: "cannot disable account",
            }),
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
          await tx.address.updateMany({
            where: {
              userId,
              mailboxManaged: true,
              NOT: { lastAccountId: parsed.data.accountId },
            },
            data: { ready: false, revision: { increment: 1 } },
          });
        }),
        failure,
      );
    },
  });
};
