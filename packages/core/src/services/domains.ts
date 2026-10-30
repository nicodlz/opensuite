import { err, ok, type Result } from "neverthrow";
import {
  DomainName,
  LocalPart,
  type DnsRecord,
  type ManagedDomain,
} from "@opensuite/contracts";
import type { createDomainStore } from "@opensuite/db";
import type { Actor } from "./accounts.ts";

type Failure = {
  kind: "forbidden" | "unavailable" | "invalid";
  message: string;
};
type Outcome<T> = PromiseLike<Result<T, Failure>>;
type Store = ReturnType<typeof createDomainStore>;
type DomainRow = ManagedDomain & { stalwartId: string | null };
export interface DomainProvider {
  ensure(
    name: string,
  ): Outcome<{ verificationToken: string; dkimTokens: string[] }>;
  receipt(name: string, add: boolean): Outcome<void>;
  verified(name: string): Outcome<boolean>;
}
export interface DomainMail {
  findDomain(name: string): Outcome<{ id: string; name: string }>;
  createDomain(name: string): Outcome<{ id: string; name: string }>;
  dkimRecords(
    id: string,
  ): Outcome<{ type: "TXT"; name: string; value: string }[]>;
  createAlias(
    accountId: string,
    name: string,
    domainId: string,
  ): Outcome<unknown>;
  removeAlias(accountId: string, name: string, domainId: string): Outcome<void>;
}
export interface DnsPort {
  lookup(record: DnsRecord): Outcome<boolean>;
}
const unavailable = (): Failure => ({
  kind: "unavailable",
  message: "domain operation failed; reconcile before retrying",
});
const invalid = (): Failure => ({
  kind: "invalid",
  message: "invalid domain operation",
});
const denied = (): Failure => ({
  kind: "forbidden",
  message: "admin access required",
});
const pending = (
  type: DnsRecord["type"],
  name: string,
  value: string,
  priority?: number,
): DnsRecord => ({
  type,
  name,
  value,
  status: "pending",
  ...(priority === undefined ? {} : { priority }),
});

export function createDomainService(
  store: Store,
  provider: DomainProvider,
  mail: DomainMail,
  dns: DnsPort,
  options: { adoptionOnly?: boolean } = {},
) {
  async function prepare(name: string) {
    const domain = await (options.adoptionOnly === true
      ? mail.findDomain(name)
      : mail.createDomain(name));
    if (domain.isErr()) return err(unavailable());
    const keys = await mail.dkimRecords(domain.value.id);
    if (keys.isErr() || keys.value.length === 0) return err(unavailable());
    const identity = await provider.ensure(name);
    if (identity.isErr()) return err(unavailable());
    if (
      !identity.value.verificationToken ||
      identity.value.dkimTokens.length === 0
    )
      return err(unavailable());
    const recipient = await provider.receipt(name, true);
    if (recipient.isErr()) return err(unavailable());
    const records = [
      pending("MX", name, "inbound-smtp.eu-north-1.amazonaws.com", 10),
      pending("TXT", name, "v=spf1 include:amazonses.com ~all"),
      pending("TXT", `_dmarc.${name}`, "v=DMARC1; p=none"),
      pending("TXT", `_amazonses.${name}`, identity.value.verificationToken),
      ...keys.value.map((key) => pending(key.type, key.name, key.value)),
      ...identity.value.dkimTokens.map((token) =>
        pending(
          "CNAME",
          `${token}._domainkey.${name}`,
          `${token}.dkim.amazonses.com`,
        ),
      ),
    ];
    if (options.adoptionOnly === true) {
      const checks = await Promise.all(
        records.map(async (record): Promise<DnsRecord> => {
          const result = await dns.lookup(record);
          return {
            ...record,
            status: result.isOk() && result.value ? "verified" : "failing",
          };
        }),
      );
      if (checks.some((record) => record.status !== "verified"))
        return err(unavailable());
      return ok({
        stalwartId: domain.value.id,
        status: "verified" as const,
        records: checks,
        checkedAt: new Date(),
      });
    }
    return ok({
      stalwartId: domain.value.id,
      status: "pending" as const,
      records,
    });
  }
  async function provision(
    actor: Actor,
    row: DomainRow,
  ): Promise<Result<DomainRow, Failure>> {
    const prepared = await prepare(row.name);
    if (prepared.isErr()) return err(unavailable());
    const saved = await store.save(
      actor.id,
      row.id,
      prepared.value,
      "admin.domain.provision",
    );
    return saved.isErr() ? err(unavailable()) : ok(saved.value);
  }
  return {
    async list(actor: Actor) {
      if (actor.role !== "admin") return err(denied());
      return store.list(actor.id);
    },
    async add(
      actor: Actor,
      name: string,
    ): Promise<Result<ManagedDomain, Failure>> {
      if (actor.role !== "admin") return err(denied());
      const parsed = DomainName.safeParse(name);
      if (!parsed.success) return err(invalid());
      if (options.adoptionOnly === true) {
        const prepared = await prepare(parsed.data);
        if (prepared.isErr()) return err(unavailable());
        const created = await store.create(actor.id, parsed.data);
        if (created.isErr()) return err(unavailable());
        const saved = await store.save(
          actor.id,
          created.value.id,
          prepared.value,
          "admin.domain.provision",
        );
        return saved.isErr() ? err(unavailable()) : ok(saved.value);
      }
      const created = await store.create(actor.id, parsed.data);
      if (created.isErr()) return err(unavailable());
      return provision(actor, created.value);
    },
    async recheck(
      actor: Actor,
      id: string,
      source: "manual" | "scheduled" = "manual",
    ): Promise<Result<ManagedDomain, Failure>> {
      if (actor.role !== "admin") return err(denied());
      if (
        (
          await store.audit(
            actor.id,
            `admin.domain.recheck.${source}.attempt`,
            id,
          )
        ).isErr()
      )
        return err(unavailable());
      const found = await store.get(id);
      if (found.isErr()) return err(unavailable());
      let row = found.value;
      if (row.stalwartId === null || row.records.length === 0) {
        const result = await provision(actor, row);
        if (result.isErr()) return result;
        row = result.value;
      }
      const checks = await Promise.all(
        row.records.map(async (record): Promise<DnsRecord> => {
          const result = await dns.lookup(record);
          return {
            ...record,
            status: result.isOk() && result.value ? "verified" : "failing",
          };
        }),
      );
      const ses =
        options.adoptionOnly === true
          ? undefined
          : await provider.verified(row.name);
      const receipt =
        options.adoptionOnly === true
          ? await provider.receipt(row.name, true)
          : ok(undefined);
      const currentIdentity =
        options.adoptionOnly === true
          ? await provider.ensure(row.name)
          : undefined;
      const identityRecordsMatch =
        currentIdentity === undefined ||
        (currentIdentity.isOk() &&
          checks.some(
            (record) =>
              record.name === `_amazonses.${row.name}` &&
              record.value === currentIdentity.value.verificationToken,
          ) &&
          currentIdentity.value.dkimTokens.every((token) =>
            checks.some(
              (record) =>
                record.name === `${token}._domainkey.${row.name}` &&
                record.value === `${token}.dkim.amazonses.com`,
            ),
          ));
      const verified =
        checks.every((record) => record.status === "verified") &&
        (ses === undefined || (ses.isOk() && ses.value)) &&
        receipt.isOk() &&
        identityRecordsMatch;
      const saved = await store.save(
        actor.id,
        id,
        {
          status: verified ? "verified" : "failing",
          records: checks,
          checkedAt: new Date(),
        },
        `admin.domain.recheck.${source}`,
      );
      return saved.isErr() ? err(unavailable()) : ok(saved.value);
    },
    async remove(actor: Actor, id: string): Promise<Result<void, Failure>> {
      if (actor.role !== "admin") return err(denied());
      if (
        (await store.audit(actor.id, "admin.domain.remove.attempt", id)).isErr()
      )
        return err(unavailable());
      const row = await store.get(id);
      if (row.isErr()) return err(unavailable());
      if (row.value.addresses.length > 0) return err(invalid());
      const reserved = await store.beginRemoval(id);
      if (reserved.isErr()) return err(unavailable());
      if (!reserved.value) return err(invalid());
      const result = await provider.receipt(row.value.name, false);
      if (result.isErr()) {
        await store.cancelRemoval(id);
        return err(unavailable());
      }
      const removed = await store.remove(actor.id, id);
      return removed.isErr() ? err(unavailable()) : ok(undefined);
    },
    async addAddress(
      actor: Actor,
      input: {
        domainId: string;
        userId: string;
        localPart: string;
        isAlias: boolean;
      },
    ): Promise<Result<ManagedDomain, Failure>> {
      if (actor.role !== "admin") return err(denied());
      const lease = await store.withUserLease(input.userId, async () => {
        if (
          (
            await store.audit(
              actor.id,
              "admin.domain.address.add.attempt",
              input.domainId,
            )
          ).isErr()
        )
          return err(unavailable());
        const part = LocalPart.safeParse(input.localPart);
        if (!part.success) return err(invalid());
        const row = await store.get(input.domainId);
        if (row.isErr() || row.value.stalwartId === null)
          return err(unavailable());
        const existing = row.value.addresses.find(
          (address) => address.localPart.toLowerCase() === part.data,
        );
        if (existing !== undefined) {
          const managed = await store.isManagedAddress(existing.id);
          if (managed.isErr()) return err(unavailable());
          if (
            managed.value ||
            existing.userId !== input.userId ||
            existing.isAlias !== input.isAlias
          )
            return err(invalid());
        }
        const mailbox = await store.mailbox(input.userId);
        if (mailbox.isErr()) return err(unavailable());
        if (
          !input.isAlias &&
          mailbox.value.address.toLowerCase() !==
            `${part.data}@${row.value.name}`
        )
          return err(invalid());
        const result =
          existing === undefined
            ? await store.addAddress(
                actor.id,
                input.domainId,
                input.userId,
                part.data,
                input.isAlias,
              )
            : ok(row.value);
        if (result.isErr()) return err(unavailable());
        if (input.isAlias) {
          const alias = await mail.createAlias(
            mailbox.value.accountId,
            part.data,
            row.value.stalwartId,
          );
          if (alias.isErr()) return err(unavailable());
        }
        return ok(result.value);
      });
      return lease.isErr() ? err(unavailable()) : lease.value;
    },
    async removeAddress(
      actor: Actor,
      domainId: string,
      addressId: string,
    ): Promise<Result<ManagedDomain, Failure>> {
      if (actor.role !== "admin") return err(denied());
      if (
        (
          await store.audit(
            actor.id,
            "admin.domain.address.remove.attempt",
            domainId,
          )
        ).isErr()
      )
        return err(unavailable());
      const row = await store.get(domainId);
      if (row.isErr() || row.value.stalwartId === null)
        return err(unavailable());
      const address = row.value.addresses.find((item) => item.id === addressId);
      if (address === undefined) return err(invalid());
      const managed = await store.isManagedAddress(addressId);
      if (managed.isErr()) return err(unavailable());
      if (managed.value) return err(invalid());
      const lease = await store.withUserLease(address.userId, async () => {
        const current = await store.get(domainId);
        if (
          current.isErr() ||
          current.value.stalwartId === null ||
          !current.value.addresses.some(
            (item) => item.id === addressId && item.userId === address.userId,
          )
        )
          return err(invalid());
        const stillManaged = await store.isManagedAddress(addressId);
        if (stillManaged.isErr()) return err(unavailable());
        if (stillManaged.value) return err(invalid());
        if (address.isAlias) {
          const mailbox = await store.mailbox(address.userId);
          if (mailbox.isErr()) return err(unavailable());
          const result = await mail.removeAlias(
            mailbox.value.accountId,
            address.localPart,
            current.value.stalwartId,
          );
          if (result.isErr()) return err(unavailable());
        }
        const removed = await store.removeAddress(
          actor.id,
          domainId,
          addressId,
        );
        return removed.isErr() ? err(unavailable()) : ok(removed.value);
      });
      return lease.isErr() ? err(unavailable()) : lease.value;
    },
  };
}
export type DomainService = ReturnType<typeof createDomainService>;
