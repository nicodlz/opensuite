import { AddressLocalPart } from "@opensuite/contracts";
import { isReservedMailLocalPart } from "../reserved-mail-local-parts.ts";
import type { AddressStore } from "@opensuite/db";
import type { Actor } from "./accounts.ts";
import type { AliasMail } from "./aliases.ts";
import { err, ok, type Result } from "neverthrow";

export type AddressLimit = (actor: Actor) => Promise<number | null>;
type Failure = { kind: string };
const failed = (kind: string): Result<never, Failure> => err({ kind });
const view = (
  row: {
    id: string;
    localPart: string;
    ready: boolean;
    active: boolean;
    removalPending: boolean;
    domain: {
      name: string;
      status: string;
      removalPending: boolean;
      user: { role: string; disabled: boolean };
    };
  },
  configured: readonly string[],
) => ({
  id: row.id,
  address: `${row.localPart}@${row.domain.name}`,
  primary: false,
  ready:
    row.ready &&
    row.active &&
    !row.removalPending &&
    !row.domain.removalPending &&
    (configured.includes(row.domain.name) ||
      (row.domain.status === "verified" &&
        row.domain.user.role === "admin" &&
        !row.domain.user.disabled)),
  removing: row.removalPending,
  pending: !row.ready,
});
export function createAddressService(
  store: AddressStore,
  mail: AliasMail,
  addressLimit: AddressLimit,
  ensureDomains: () => Promise<Result<void, Failure>>,
  configured: readonly string[],
) {
  const sync = async (
    userId: string,
    id: string,
  ): Promise<Result<void, Failure>> => {
    const leased = await store.withUserLease(userId, async (token) => {
      const found = await store.snapshot(userId, id);
      if (found.isErr()) return found;
      const row = found.value;
      if (!row) return failed("not_found");
      const mailbox = row.user.mailbox;
      const domainUsable =
        !row.domain.removalPending &&
        (configured.includes(row.domain.name) ||
          (row.domain.status === "verified" &&
            row.domain.user.role === "admin" &&
            !row.domain.user.disabled));
      const enabled =
        !row.removalPending &&
        domainUsable &&
        !row.user.disabled &&
        mailbox?.status === "active";
      const accountId = mailbox?.accountId ?? row.lastAccountId;
      if (!row.domain.stalwartId) return failed("unavailable");
      const email = `${row.localPart}@${row.domain.name}`;
      if (row.lastAccountId && row.lastAccountId !== accountId) {
        const removed = await mail.set(
          row.lastAccountId,
          row.localPart,
          row.domain.stalwartId,
          email,
          userId,
          false,
        );
        if (removed.isErr()) return failed("unavailable");
      }
      if (accountId) {
        const result = await mail.set(
          accountId,
          row.localPart,
          row.domain.stalwartId,
          email,
          userId,
          enabled,
        );
        if (result.isErr()) return failed("unavailable");
      } else if (enabled || row.removalPending) return failed("unavailable");
      const saved = await store.finish(
        userId,
        id,
        token,
        row,
        accountId,
        enabled,
      );
      if (saved.isErr() || !saved.value) return failed("unavailable");
      return ok(undefined);
    });
    if (leased.isErr() || leased.value.isErr()) {
      await store.dirty(userId, id);
      return failed(
        leased.isErr()
          ? leased.error.kind
          : leased.value.isErr()
            ? leased.value.error.kind
            : "unavailable",
      );
    }
    return ok(undefined);
  };
  return {
    domains: async () => {
      const result = await store.domains();
      return result;
    },
    ensureDomains,
    list: async (actor: Actor) => {
      let limit: number | null;
      try {
        limit = await addressLimit(actor);
      } catch {
        return failed("unavailable");
      }
      const rows = await store.list(actor.id);
      if (rows.isErr()) return err(rows.error);
      const addresses = [
        {
          id: "primary",
          address: rows.value.email,
          primary: true,
          ready: true,
          removing: false,
          pending: false,
        },
        ...rows.value.addresses.map((row) => view(row, configured)),
      ];
      return ok({
        addresses,
        limit,
        remaining:
          limit === null ? null : Math.max(0, limit - addresses.length),
      });
    },
    create: async (
      actor: Actor,
      input: { localPart: string; domainId: string },
    ) => {
      const parsed = AddressLocalPart.safeParse(input.localPart);
      if (!parsed.success) return failed("invalid");
      if (isReservedMailLocalPart(parsed.data)) {
        await store.audit(actor.id, "address.create.failure");
        return failed("reserved");
      }
      let limit: number | null;
      try {
        limit = await addressLimit(actor);
      } catch {
        return failed("unavailable");
      }
      const reserved = await store.reserve(
        actor.id,
        input.domainId,
        parsed.data,
        limit,
      );
      if (reserved.isErr()) {
        await store.audit(actor.id, "address.create.failure");
        return err(reserved.error);
      }
      const result = await sync(actor.id, reserved.value.id);
      if (result.isErr() && result.error.kind !== "busy") {
        await store.audit(
          actor.id,
          "address.create.failure",
          reserved.value.id,
        );
      }
      const current = await store.snapshot(actor.id, reserved.value.id);
      return current.isOk() && current.value
        ? ok(view(current.value, configured))
        : failed("unavailable");
    },
    remove: async (actor: Actor, id: string) => {
      const result = await store.remove(actor.id, id);
      if (result.isErr()) {
        await store.audit(actor.id, "address.remove.failure");
        return err(result.error);
      }
      const synced = await sync(actor.id, id);
      if (synced.isErr()) {
        await store.audit(actor.id, "address.remove.failure", id);
        return err(synced.error);
      }
      return ok({ removed: true as const });
    },
    auditSubmission: async (userId: string, id: string) => {
      const result = await store.audit(
        userId,
        "address.submission.attempt",
        id,
      );
      return result;
    },
    canSendAs: async (userId: string, email: string) =>
      (await store.canSendAs(userId, email)).map((row) => row?.id ?? null),
    reconcile: async () => {
      const changed = await store.markChanged();
      if (changed.isErr()) return err(changed.error);
      const pending = await store.pending();
      if (pending.isErr()) return pending;
      let failures = 0;
      for (const row of pending.value)
        if ((await sync(row.userId, row.id)).isErr()) failures++;
      return ok(failures);
    },
  };
}
export type AddressService = ReturnType<typeof createAddressService>;
