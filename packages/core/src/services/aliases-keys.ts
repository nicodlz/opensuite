import { randomBytes, timingSafeEqual } from "node:crypto";
import type { AliasStore } from "@opensuite/db";
import { err, ok } from "neverthrow";
import { failure, hash, keyView, run } from "./aliases-helpers.ts";

export function createAliasKeys(store: AliasStore) {
  return {
    createKey: (userId: string, name: string) =>
      run(async () => {
        const prefix = randomBytes(9).toString("base64url");
        const secret = `osa_${prefix}_${randomBytes(32).toString("base64url")}`;
        const row = await store.createKey(userId, name, prefix, hash(secret));
        return row.isErr()
          ? err(row.error)
          : ok({ ...keyView(row.value), secret });
      }),
    listKeys: async (userId: string) =>
      (await store.listKeys(userId)).map((rows) => rows.map(keyView)),
    revokeKey: async (userId: string, id: string) =>
      store.revokeKey(userId, id),
    authenticate: (secret: string) =>
      run(async () => {
        const match = /^osa_([A-Za-z0-9_-]{12})_[A-Za-z0-9_-]{43}$/.exec(
          secret,
        );
        if (!match?.[1]) return err(failure("invalid"));
        const found = await store.keyForPrefix(match[1]);
        if (found.isErr()) return err(found.error);
        const row = found.value;
        const actual = Buffer.from(hash(secret), "hex");
        const expected = Buffer.from(row?.secretHash ?? "0".repeat(64), "hex");
        if (
          !timingSafeEqual(actual, expected) ||
          !row ||
          row.revokedAt ||
          row.user.disabled
        )
          return err(failure("invalid"));
        const used = await store.useKey(row.id);
        if (used.isErr()) return err(used.error);
        return used.value
          ? ok({ userId: row.userId, keyId: row.id })
          : err(failure("invalid"));
      }),
  };
}
