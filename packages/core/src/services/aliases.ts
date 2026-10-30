import type { AliasStore } from "@opensuite/db";
import { err, ok, type Result } from "neverthrow";
import { z } from "zod";

export interface AliasMail {
  set(
    accountId: string,
    localPart: string,
    domainId: string,
    address: string,
    userId: string,
    enabled: boolean,
  ): PromiseLike<Result<void, { kind: string }>>;
}
export interface AliasCreate {
  domainId?: string | undefined;
  prefix?: string | undefined;
  requestId?: string | undefined;
  website?: string | null | undefined;
  note?: string | null | undefined;
}
export { generateAliasLocalPart } from "./aliases-helpers.ts";
import { run, view } from "./aliases-helpers.ts";
import { createAliasSync } from "./aliases-sync.ts";
import { createAliasOperations } from "./aliases-operations.ts";
import { createAliasKeys } from "./aliases-keys.ts";
export function createAliasService(
  store: AliasStore,
  mail: AliasMail,
  cap: number,
) {
  const sync = createAliasSync(store, mail);
  return {
    findRequest: async (userId: string, requestId: string) =>
      (await store.findRequest(userId, requestId)).map((row) => row !== null),
    domains: async () => store.domains(),
    list: async (userId: string, search?: string) =>
      (await store.list(userId, search)).map((rows) => rows.map(view)),
    ...createAliasOperations(store, cap, sync),
    transition: (
      userId: string,
      id: string,
      desired: "enable" | "disable" | "delete",
    ) =>
      run(async () => {
        const changed = await store.transition(userId, id, desired);
        return changed.isErr() ? err(changed.error) : sync(userId, id);
      }),
    match: async (userId: string, addresses: string[]) => {
      const valid = addresses.flatMap((entry) => {
        const candidate = /<([^<>]+)>\s*$/.exec(entry)?.[1] ?? entry;
        const parsed = z.email().safeParse(candidate.trim().toLowerCase());
        return parsed.success ? [parsed.data] : [];
      });
      return (await store.match(userId, valid)).map((rows) => rows.map(view));
    },
    setDefault: async (userId: string, domainId: string) =>
      store.setDefault(userId, domainId),
    getDefault: async (userId: string) => store.getDefault(userId),
    ...createAliasKeys(store),
    reconcile: () =>
      run(async () => {
        const pending = await store.pending();
        if (pending.isErr()) return err(pending.error);
        let failures = 0;
        for (const row of pending.value)
          if ((await sync(row.userId, row.id)).isErr()) failures++;
        return ok(failures);
      }),
    canSendAs: async (userId: string, address: string) =>
      (await store.canSendAs(userId, address)).map((row) => row?.id ?? null),
    auditSubmission: async (userId: string, aliasId: string) =>
      store.auditSubmission(userId, aliasId),
  };
}
export type AliasService = ReturnType<typeof createAliasService>;
