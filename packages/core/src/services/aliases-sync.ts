import type { AliasStore } from "@opensuite/db";
import { err, ok, type Result } from "neverthrow";
import type { AliasMail } from "./aliases.ts";
import {
  failure,
  run,
  view,
  type Failure,
  type Output,
} from "./aliases-helpers.ts";

type Snapshot = NonNullable<
  Awaited<ReturnType<AliasStore["snapshot"]>> extends Result<infer T, unknown>
    ? T
    : never
>;

export function createAliasSync(store: AliasStore, mail: AliasMail) {
  return (userId: string, id: string): Output<ReturnType<typeof view>> =>
    run(async () => {
      const leased = await store.withUserLease(userId, async (token) => {
        return syncLeased(store, mail, userId, id, token);
      });
      if (leased.isErr()) {
        await store.touch(userId, id);
        return err(failure(leased.error.kind));
      }
      if (leased.value.isErr()) await store.touch(userId, id);
      return leased.value;
    });
}

async function syncLeased(
  store: AliasStore,
  mail: AliasMail,
  userId: string,
  id: string,
  token: string,
): Output<ReturnType<typeof view>> {
  const found = await store.snapshot(userId, id);
  if (found.isErr()) return err(found.error);
  const row = found.value;
  if (!row) return err(failure("not_found"));
  const { detachedByDomain, suspended, enabled } = syncState(row);
  const mailbox = row.user.mailbox;
  const accountId = mailbox?.accountId ?? row.lastAccountId;
  const synced = await syncMail(mail, row, userId, accountId, enabled);
  if (synced.isErr()) return err(synced.error);
  const saved = await store.finish(userId, id, token, row, {
    ready: true,
    detachedByDomain,
    suspended,
    lastAccountId: accountId ?? null,
  });
  if (saved.isErr()) return err(saved.error);
  if (!saved.value) {
    await store.dirty(userId, id);
    return err(failure("unavailable"));
  }
  const current = await store.get(userId, id);
  if (current.isErr()) return err(current.error);
  return current.value ? ok(view(current.value)) : err(failure("not_found"));
}

async function syncMail(
  mail: AliasMail,
  row: Snapshot,
  userId: string,
  accountId: string | null,
  enabled: boolean,
): Promise<Result<void, Failure>> {
  const mailbox = row.user.mailbox;
  if (accountId) {
    if (!row.domain.stalwartId) return err(failure("unavailable"));
    if (
      mailbox &&
      row.lastAccountId &&
      row.lastAccountId !== mailbox.accountId
    ) {
      const removed = await mail.set(
        row.lastAccountId,
        row.localPart,
        row.domain.stalwartId,
        row.address,
        userId,
        false,
      );
      if (removed.isErr()) return err(failure("unavailable"));
    }
    const result = await mail.set(
      accountId,
      row.localPart,
      row.domain.stalwartId,
      row.address,
      userId,
      enabled,
    );
    if (result.isErr()) return err(failure("unavailable"));
  } else if (mailbox) return err(failure("unavailable"));
  return ok(undefined);
}

function syncState(row: Snapshot) {
  const mailbox = row.user.mailbox;
  const detachedByDomain =
    row.enabled && row.deletedAt === null && row.domain.status !== "verified";
  const suspended =
    row.enabled &&
    row.deletedAt === null &&
    (row.user.disabled || !mailbox || mailbox.status !== "active");
  const enabled =
    row.enabled && row.deletedAt === null && !detachedByDomain && !suspended;
  return { detachedByDomain, suspended, enabled };
}
