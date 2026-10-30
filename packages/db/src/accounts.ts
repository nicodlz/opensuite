import { err, errAsync, ok, ResultAsync } from "neverthrow";
import { z } from "zod";
import type { PrismaClient } from "./generated/index.js";

const Actor = z.object({
  id: z.string(),
  email: z.email(),
  role: z.enum(["admin", "user"]),
});
const failed = (): { kind: "unavailable"; message: string } => ({
  kind: "unavailable",
  message: "account operation failed",
});
export const createAccountStore = (db: PrismaClient) => ({
  bootstrap(email: string) {
    return ResultAsync.fromPromise(
      db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(1984327101)::text`;
        const user = await tx.user.findFirst({
          where: {
            email: email.toLowerCase(),
            disabled: false,
            mailbox: { status: "active" },
          },
          select: { id: true },
        });
        if (user === null)
          throw new Error("enabled, provisioned user not found");
        await tx.user.update({
          where: { id: user.id },
          data: { role: "admin" },
        });
        await tx.auditEvent.create({
          data: { userId: user.id, action: "admin.bootstrap", detail: {} },
        });
      }),
      failed,
    );
  },
  userIdForEmail(email: string) {
    return ResultAsync.fromPromise(
      db.user.findUnique({
        where: { email: email.toLowerCase() },
        select: { id: true },
      }),
      failed,
    ).map((user) => user?.id ?? null);
  },
  audit(event: { userId: string | null; action: string }) {
    return ResultAsync.fromPromise(
      db.auditEvent.create({
        data: { userId: event.userId, action: event.action, detail: {} },
      }),
      failed,
    ).map(() => undefined);
  },
  actor(userId: string) {
    return ResultAsync.fromPromise(
      db.user.findFirst({
        where: { id: userId, disabled: false },
        select: { id: true, email: true, role: true },
      }),
      failed,
    ).andThen((value) => {
      if (value === null) return ok(null);
      const parsed = Actor.safeParse(value);
      return parsed.success ? ok(parsed.data) : err(failed());
    });
  },
  mailbox(actor: z.infer<typeof Actor>, accountId: string) {
    return ResultAsync.fromPromise(
      db.mailboxLink.findFirst({
        where: {
          userId: actor.id,
          accountId,
          status: "active",
          user: { disabled: false },
        },
        select: { accountId: true, address: true },
      }),
      failed,
    ).andThen((value) =>
      value === null
        ? err<never, { kind: "forbidden"; message: string }>({
            kind: "forbidden",
            message: "mailbox access denied",
          })
        : ok(value),
    );
  },
  list(actor: z.infer<typeof Actor>) {
    if (actor.role !== "admin")
      return errAsync<never, { kind: "forbidden"; message: string }>({
        kind: "forbidden",
        message: "access denied",
      });
    return ResultAsync.fromPromise(
      (async () => {
        const users = await db.user.findMany({
          where: { disabled: false },
          select: { id: true, email: true, role: true },
          orderBy: { createdAt: "asc" },
        });
        await db.auditEvent.create({
          data: { userId: actor.id, action: "admin.accounts.list", detail: {} },
        });
        return z.array(Actor).parse(users);
      })(),
      failed,
    );
  },
});
