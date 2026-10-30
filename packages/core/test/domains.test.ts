import { err, ok, okAsync } from "neverthrow";
import { describe, expect, it, vi } from "vitest";
import type { DnsRecord, ManagedDomain } from "@opensuite/contracts";
import type { createDomainStore } from "@opensuite/db";
import {
  createDomainService,
  type DomainMail,
  type DomainProvider,
  type DnsPort,
} from "../src/services/domains.ts";
import { createSesDomainProvider } from "../src/adapters/domain-ses.ts";

const actor = {
  id: "admin",
  email: "admin@example.test",
  role: "admin",
} satisfies { id: string; email: string; role: "admin" | "user" };
type Row = ManagedDomain & { stalwartId: string | null };
type Failure = { kind: "unavailable"; message: string };
const success = <T>(value: T) => okAsync<T, Failure>(value);
function fixture() {
  let row: Row = {
    id: "1",
    name: "example.test",
    stalwartId: null,
    status: "pending",
    checkedAt: null,
    records: [],
    addresses: [],
  };
  const audits: string[] = [];
  const store: ReturnType<typeof createDomainStore> = {
    verificationTargets: () => success([]),
    audit: (_actor, action) => {
      audits.push(action);
      return success(undefined);
    },
    list: () => success([row]),
    get: () => success(row),
    create: (_actor, name) => {
      row = { ...row, name };
      audits.push("add");
      return success(row);
    },
    save: (_actor, _id, data, action) => {
      row = {
        ...row,
        ...data,
        stalwartId: data.stalwartId ?? row.stalwartId,
        checkedAt: data.checkedAt?.toISOString() ?? row.checkedAt,
      };
      audits.push(action);
      return success(row);
    },
    remove: () => {
      audits.push("remove");
      return success(undefined);
    },
    mailbox: () =>
      success({ accountId: "account", address: "person@example.test" }),
    addAddress: (_actor, _domain, userId, localPart, isAlias) => {
      row = {
        ...row,
        addresses: [...row.addresses, { id: "a", userId, localPart, isAlias }],
      };
      return success(row);
    },
    removeAddress: () => {
      row = { ...row, addresses: [] };
      return success(row);
    },
    routes: () => success([]),
  };
  const provider: DomainProvider = {
    ensure: () =>
      Promise.resolve(
        ok({ verificationToken: "verify", dkimTokens: ["token"] }),
      ),
    receipt: () => Promise.resolve(ok(undefined)),
    verified: () => Promise.resolve(ok(true)),
  };
  const mail: DomainMail = {
    createDomain: (name) => Promise.resolve(ok({ id: "stalwart", name })),
    dkimRecords: () =>
      Promise.resolve(
        ok([
          {
            type: "TXT",
            name: "s._domainkey.example.test",
            value: "public-key",
          },
        ]),
      ),
    createAlias: () => Promise.resolve(ok(undefined)),
    removeAlias: () => Promise.resolve(ok(undefined)),
  };
  let published = true;
  const dns: DnsPort = {
    lookup: (record: DnsRecord) =>
      Promise.resolve(
        record.type === "MX" && !published
          ? err({ kind: "unavailable", message: "missing" })
          : ok(true),
      ),
  };
  return {
    service: createDomainService(store, provider, mail, dns),
    audits,
    mail,
    provider,
    failMx() {
      published = false;
    },
  };
}
describe("domain management", () => {
  it("provisions records, verifies DNS and SES, and records failures", async () => {
    const f = fixture();
    const added = await f.service.add(actor, "EXAMPLE.TEST");
    expect(added.isOk()).toBe(true);
    if (added.isErr()) return;
    expect(added.value.name).toBe("example.test");
    expect(added.value.records.map((r) => r.name)).toEqual(
      expect.arrayContaining([
        "example.test",
        "_amazonses.example.test",
        "s._domainkey.example.test",
        "token._domainkey.example.test",
      ]),
    );
    const checked = await f.service.recheck(actor, "1");
    expect(checked.isOk() && checked.value.status).toBe("verified");
    f.failMx();
    const failed = await f.service.recheck(actor, "1");
    expect(failed.isOk() && failed.value.status).toBe("failing");
    expect(f.audits).toEqual([
      "add",
      "admin.domain.provision",
      "admin.domain.recheck.manual.attempt",
      "admin.domain.recheck.manual",
      "admin.domain.recheck.manual.attempt",
      "admin.domain.recheck.manual",
    ]);
  });
  it("enforces admin role and manages aliases against the target mailbox", async () => {
    const f = fixture();
    expect(
      (await f.service.add({ ...actor, role: "user" }, "example.test")).isErr(),
    ).toBe(true);
    await f.service.add(actor, "example.test");
    const create = vi.spyOn(f.mail, "createAlias");
    const added = await f.service.addAddress(actor, {
      domainId: "1",
      userId: "owner",
      localPart: "Sales",
      isAlias: true,
    });
    expect(added.isOk()).toBe(true);
    expect(create).toHaveBeenCalledWith("account", "sales", "stalwart");
    expect((await f.service.remove(actor, "1")).isErr()).toBe(true);
    expect((await f.service.removeAddress(actor, "1", "a")).isOk()).toBe(true);
    expect((await f.service.remove(actor, "1")).isOk()).toBe(true);
  });
  it("does not instantiate the AWS adapter unless enabled", () => {
    expect(
      createSesDomainProvider({ enabled: false, ruleName: "" }),
    ).toBeUndefined();
  });
});
