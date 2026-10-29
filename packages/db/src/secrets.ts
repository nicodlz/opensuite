import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { err, ok, type Result } from "neverthrow";
import { z } from "zod";
import type { DatabaseError } from "./errors.ts";

const Environment = z.object({
  DATABASE_URL: z.url().refine((value) => {
    if (!URL.canParse(value)) return false;
    const protocol = new URL(value).protocol;
    return protocol === "postgres:" || protocol === "postgresql:";
  }),
  PROVIDER_ENCRYPTION_KEY: z.string().regex(/^[0-9a-fA-F]{64}$/),
});

export interface DatabaseConfig {
  readonly url: string;
  readonly encryptionKey: string;
}

export const loadDatabaseConfig = (
  env: unknown,
): Result<DatabaseConfig, DatabaseError> => {
  const parsed = Environment.safeParse(env);
  if (!parsed.success) {
    return err({
      kind: "invalid_environment",
      message: "DATABASE_URL or PROVIDER_ENCRYPTION_KEY is invalid",
    });
  }
  return ok({
    url: parsed.data.DATABASE_URL,
    encryptionKey: parsed.data.PROVIDER_ENCRYPTION_KEY,
  });
};

const Encoded = z
  .string()
  .regex(/^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{22}$/);
const Context = z.object({ userId: z.string().min(1), id: z.string().min(1) });
const aad = (context: z.infer<typeof Context>) =>
  Buffer.from(JSON.stringify([context.userId, context.id]));

const encryptSecret = (
  key: Buffer,
  value: unknown,
  context: unknown,
): Result<string, DatabaseError> => {
  const input = z.string().min(1).safeParse(value);
  const owner = Context.safeParse(context);
  if (!input.success || !owner.success)
    return err({
      kind: "invalid_input",
      message: "invalid secret or context",
    });
  try {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(aad(owner.data));
    const encrypted = Buffer.concat([
      cipher.update(input.data, "utf8"),
      cipher.final(),
    ]);
    return ok(
      [
        "v1",
        nonce.toString("base64url"),
        encrypted.toString("base64url"),
        cipher.getAuthTag().toString("base64url"),
      ].join("."),
    );
  } catch {
    return err({
      kind: "crypto_error",
      message: "secret encryption failed",
    });
  }
};

const decryptSecret = (
  key: Buffer,
  value: unknown,
  context: unknown,
): Result<string, DatabaseError> => {
  const input = Encoded.safeParse(value);
  const owner = Context.safeParse(context);
  if (!input.success || !owner.success)
    return err({
      kind: "crypto_error",
      message: "invalid encrypted secret",
    });
  const parts = input.data.split(".");
  const nonce = parts[1];
  const ciphertext = parts[2];
  const tag = parts[3];
  if (nonce === undefined || ciphertext === undefined || tag === undefined)
    return err({
      kind: "crypto_error",
      message: "invalid encrypted secret",
    });
  try {
    const nonceBytes = Buffer.from(nonce, "base64url");
    const encryptedBytes = Buffer.from(ciphertext, "base64url");
    const tagBytes = Buffer.from(tag, "base64url");
    if (
      nonceBytes.toString("base64url") !== nonce ||
      encryptedBytes.toString("base64url") !== ciphertext ||
      tagBytes.toString("base64url") !== tag
    )
      return err({
        kind: "crypto_error",
        message: "invalid encrypted secret",
      });
    const decipher = createDecipheriv("aes-256-gcm", key, nonceBytes);
    decipher.setAAD(aad(owner.data));
    decipher.setAuthTag(tagBytes);
    return ok(
      Buffer.concat([
        decipher.update(encryptedBytes),
        decipher.final(),
      ]).toString("utf8"),
    );
  } catch {
    return err({
      kind: "crypto_error",
      message: "secret authentication failed",
    });
  }
};

/** AES-GCM binds ciphertext to both the owner and the configuration ID. */
export const createSecretBox = (
  key: unknown,
): Result<
  {
    encrypt(value: unknown, context: unknown): Result<string, DatabaseError>;
    decrypt(value: unknown, context: unknown): Result<string, DatabaseError>;
  },
  DatabaseError
> => {
  const parsedKey = Environment.shape.PROVIDER_ENCRYPTION_KEY.safeParse(key);
  if (!parsedKey.success)
    return err({
      kind: "invalid_environment",
      message: "PROVIDER_ENCRYPTION_KEY is invalid",
    });
  const bytes = Buffer.from(parsedKey.data, "hex");
  return ok({
    encrypt: (value, context) => encryptSecret(bytes, value, context),
    decrypt: (value, context) => decryptSecret(bytes, value, context),
  });
};
