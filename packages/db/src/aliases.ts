import type { PrismaClient } from "./generated/index.js";
import { createLocked } from "./aliases-shared.ts";
import {
  createLeaseAndList,
  createSnapshot,
  createSubmission,
} from "./aliases-read.ts";
import {
  createReserve,
  createMutations,
  createDefaults,
} from "./aliases-write.ts";
import { createKeys } from "./aliases-keys.ts";
export type { AliasStoreFailure } from "./aliases-shared.ts";

export const createAliasStore = (
  db: PrismaClient,
  subscriberDomains?: readonly string[],
) => {
  const locked = createLocked(db);
  return {
    ...createLeaseAndList(db, subscriberDomains),
    ...createReserve(locked, subscriberDomains),
    ...createSnapshot(db),
    ...createMutations(db, locked),
    ...createDefaults(db, locked, subscriberDomains),
    ...createKeys(db, locked),
    ...createSubmission(db),
  };
};
export type AliasStore = ReturnType<typeof createAliasStore>;
