import { err, errAsync, ok, ResultAsync } from "neverthrow";
import { z } from "zod";
import type { PrismaClient } from "./generated/index.js";
import type { DatabaseError } from "./errors.ts";
import { createSecretBox } from "./secrets.ts";

const LinkInput = z.object({
  userId: z.string().min(1),
  accountId: z.string().min(1),
  address: z.email(),
  credentialId: z.string().min(1),
  secret: z.string().min(1),
});
const Lookup = z.object({
  userId: z.string().min(1),
  accountId: z.string().min(1),
});
const databaseFailure = (): DatabaseError => ({
  kind: "database_error",
  message: "mailbox database operation failed",
});

/** Server-only store. Ciphertext is bound to the owner and immutable mailbox account ID. */
export const createMailboxStore = (client: PrismaClient, key: unknown) => {
  const box = createSecretBox(key);
  if (box.isErr()) return err(box.error);
  return ok({
    create(input: unknown) {
      const parsed = LinkInput.safeParse(input);
      if (!parsed.success)
        return errAsync<never, DatabaseError>({
          kind: "invalid_input",
          message: "invalid mailbox link",
        });
      const { userId, accountId, address, credentialId, secret } = parsed.data;
      const encrypted = box.value.encrypt(secret, { userId, id: accountId });
      if (encrypted.isErr())
        return errAsync<never, DatabaseError>(encrypted.error);
      return ResultAsync.fromPromise(
        client.mailboxLink.create({
          data: {
            userId,
            accountId,
            address,
            credentialId,
            secret: encrypted.value,
          },
        }),
        databaseFailure,
      ).map(() => ({ userId, accountId, address }));
    },
    getForOwner(userId: string, accountId: string) {
      const parsed = Lookup.safeParse({ userId, accountId });
      if (!parsed.success)
        return errAsync<never, DatabaseError>({
          kind: "invalid_input",
          message: "invalid mailbox lookup",
        });
      return ResultAsync.fromPromise(
        client.mailboxLink.findFirst({
          where: {
            ...parsed.data,
            status: "active",
            user: { disabled: false },
          },
        }),
        databaseFailure,
      ).andThen((row) => {
        if (row === null)
          return err({ kind: "not_found", message: "mailbox not found" });
        return box.value
          .decrypt(row.secret, { userId: row.userId, id: row.accountId })
          .map((secret) => ({
            accountId: row.accountId,
            address: row.address,
            secret,
          }));
      });
    },
  });
};
