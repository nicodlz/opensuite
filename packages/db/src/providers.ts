import type { PrismaClientKnownRequestError } from "@prisma/client/runtime/library";
import { randomUUID } from "node:crypto";
import { err, errAsync, ok, ResultAsync } from "neverthrow";
import { z } from "zod";
import type { PrismaClient } from "./generated/index.js";
import type { DatabaseError } from "./errors.ts";
import { createSecretBox } from "./secrets.ts";

const CreateInput = z.object({
  userId: z.string().min(1),
  name: z.string().min(1),
  secret: z.string().min(1),
});
const GetInput = z.object({ userId: z.string().min(1), id: z.string().min(1) });
const Row = z.object({
  id: z.string().min(1),
  userId: z.string().min(1),
  name: z.string().min(1),
  secret: z.string().min(1),
});
const ErrorCode = z.object({ code: z.string() }) satisfies z.ZodType<
  Pick<PrismaClientKnownRequestError, "code">
>;
const failed = (cause: unknown): DatabaseError =>
  ErrorCode.safeParse(cause).data?.code === "P2002"
    ? { kind: "conflict", message: "provider configuration already exists" }
    : { kind: "database_error", message: "provider database operation failed" };

export const createProviderStore = (client: PrismaClient, key: unknown) => {
  const box = createSecretBox(key);
  if (box.isErr()) return err(box.error);
  return ok({
    create(input: unknown) {
      const data = CreateInput.safeParse(input);
      if (!data.success)
        return errAsync<never, DatabaseError>({
          kind: "invalid_input",
          message: "invalid provider configuration",
        });
      const id = randomUUID();
      const encrypted = box.value.encrypt(data.data.secret, {
        id,
        userId: data.data.userId,
      });
      if (encrypted.isErr())
        return errAsync<never, DatabaseError>(encrypted.error);
      return ResultAsync.fromPromise(
        client.providerConfig.create({
          data: {
            id,
            userId: data.data.userId,
            name: data.data.name,
            secret: encrypted.value,
          },
        }),
        failed,
      ).andThen((row) => {
        const parsed = Row.safeParse(row);
        if (!parsed.success)
          return err({ kind: "invalid_row", message: "invalid provider row" });
        return ok({
          id: parsed.data.id,
          userId: parsed.data.userId,
          name: parsed.data.name,
        });
      });
    },
    get(input: unknown) {
      const data = GetInput.safeParse(input);
      if (!data.success)
        return errAsync<never, DatabaseError>({
          kind: "invalid_input",
          message: "invalid provider lookup",
        });
      return ResultAsync.fromPromise(
        client.providerConfig.findFirst({ where: data.data }),
        failed,
      ).andThen((row) => {
        if (row === null)
          return err({
            kind: "not_found",
            message: "provider configuration not found",
          });
        const parsed = Row.safeParse(row);
        if (!parsed.success)
          return err({ kind: "invalid_row", message: "invalid provider row" });
        return box.value
          .decrypt(parsed.data.secret, {
            id: parsed.data.id,
            userId: parsed.data.userId,
          })
          .map((secret) => ({
            id: parsed.data.id,
            userId: parsed.data.userId,
            name: parsed.data.name,
            secret,
          }));
      });
    },
  });
};
