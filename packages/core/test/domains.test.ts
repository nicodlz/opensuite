import { err, ok, okAsync, ResultAsync } from "neverthrow";
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
  let hasDefault = false;
  let confirmedFailures = 0;
  const store: ReturnType<typeof createDomainStore> = {
    beginRemoval: () => success(!hasDefault),
    cancelRemoval: () => success(undefined),
    withUserLease: (_user, work) =>
      ResultAsync.fromPromise(work(), () => ({
        kind: "unavailable" as const,
        message: "failed",
      })),
    isManagedAddress: () => success(false),
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
    recordAdoptionCheck: (_actor, _id, outcome, records, source) => {
      confirmedFailures =
        outcome === "confirmed" ? Math.min(confirmedFailures + 1, 3) : 0;
      const status =
        outcome === "verified"
          ? "verified"
          : confirmedFailures >= 3
            ? "failing"
            : row.status;
      row = {
        ...row,
        status,
        ...(outcome === "verified" || confirmedFailures >= 3
          ? { records }
          : {}),
      };
      audits.push(`admin.domain.recheck.${source}`);
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
    findDomain: (name) => Promise.resolve(ok({ id: "stalwart", name })),
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
  let tokenPublished = true;
  const dns: DnsPort = {
    lookup: (record: DnsRecord) =>
      Promise.resolve(
        (record.type === "MX" && !published) ||
          (record.name.startsWith("_amazonses.") && !tokenPublished)
          ? err({ kind: "unavailable", message: "missing" })
          : ok(true),
      ),
  };
  return {
    service: createDomainService(store, provider, mail, dns),
    adoption: createDomainService(store, provider, mail, dns, {
      adoptionOnly: true,
    }),
    audits,
    mail,
    provider,
    setDefault() {
      hasDefault = true;
    },
    failMx() {
      published = false;
    },
    failToken() {
      tokenPublished = false;
    },
  };
}
describe("domain management", () => {
  it("refuses removal before changing SES when a user selected the default", async () => {
    const f = fixture();
    await f.service.add(actor, "example.test");
    const receipt = vi.spyOn(f.provider, "receipt");
    f.setDefault();
    expect((await f.service.remove(actor, "1")).isErr()).toBe(true);
    expect(receipt).not.toHaveBeenCalled();
  });
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
  it("adopts only after all DNS records and the existing identity and recipient are verified", async () => {
    const f = fixture();
    const find = vi.spyOn(f.mail, "findDomain");
    const create = vi.spyOn(f.mail, "createDomain");
    const adopted = await f.adoption.add(actor, "example.test");
    expect(adopted.isOk() && adopted.value.status).toBe("verified");
    expect(find).toHaveBeenCalledOnce();
    expect(create).not.toHaveBeenCalled();
    expect(f.audits).toEqual(["add", "admin.domain.provision"]);
  });
  it("does not create a local domain when DNS proof, identity, recipient or existing Stalwart domain is missing", async () => {
    const dns = fixture();
    dns.failMx();
    expect((await dns.adoption.add(actor, "example.test")).isErr()).toBe(true);
    expect(dns.audits).toEqual([]);
    const token = fixture();
    token.failToken();
    expect((await token.adoption.add(actor, "example.test")).isErr()).toBe(
      true,
    );
    expect(token.audits).toEqual([]);
    const identity = fixture();
    vi.spyOn(identity.provider, "ensure").mockResolvedValue(
      err({ kind: "unavailable", message: "missing" }),
    );
    expect((await identity.adoption.add(actor, "example.test")).isErr()).toBe(
      true,
    );
    expect(identity.audits).toEqual([]);
    const recipient = fixture();
    vi.spyOn(recipient.provider, "receipt").mockResolvedValue(
      err({ kind: "unavailable", message: "missing" }),
    );
    expect((await recipient.adoption.add(actor, "example.test")).isErr()).toBe(
      true,
    );
    expect(recipient.audits).toEqual([]);
    const dkim = fixture();
    vi.spyOn(dkim.mail, "dkimRecords").mockResolvedValue(ok([]));
    expect((await dkim.adoption.add(actor, "example.test")).isErr()).toBe(true);
    expect(dkim.audits).toEqual([]);
    const domain = fixture();
    vi.spyOn(domain.mail, "findDomain").mockResolvedValue(
      err({ kind: "unavailable", message: "missing" }),
    );
    expect((await domain.adoption.add(actor, "example.test")).isErr()).toBe(
      true,
    );
    expect(domain.audits).toEqual([]);
  });
  it("keeps the prior status on transient recheck errors and resets the confirmed streak", async () => {
    const f = fixture();
    await f.adoption.add(actor, "example.test");
    const receipt = vi.spyOn(f.provider, "receipt");
    receipt.mockResolvedValue(
      err({ kind: "confirmed", message: "recipient missing" }),
    );
    const first = await f.adoption.recheck(actor, "1");
    expect(first.isOk() && first.value.status).toBe("verified");
    receipt.mockResolvedValue(
      err({ kind: "unavailable", message: "throttled" }),
    );
    expect((await f.adoption.recheck(actor, "1")).isErr()).toBe(true);
    receipt.mockResolvedValue(
      err({ kind: "confirmed", message: "recipient missing" }),
    );
    const afterRetry = await f.adoption.recheck(actor, "1");
    expect(afterRetry.isOk() && afterRetry.value.status).toBe("verified");
  });
  it("requires three consecutive confirmed failures and restores verified status on recovery", async () => {
    const f = fixture();
    await f.adoption.add(actor, "example.test");
    const receipt = vi
      .spyOn(f.provider, "receipt")
      .mockResolvedValue(
        err({ kind: "confirmed", message: "recipient missing" }),
      );
    const first = await f.adoption.recheck(actor, "1");
    const second = await f.adoption.recheck(actor, "1");
    const third = await f.adoption.recheck(actor, "1");
    expect(first.isOk() && first.value.status).toBe("verified");
    expect(second.isOk() && second.value.status).toBe("verified");
    expect(third.isOk() && third.value.status).toBe("failing");
    receipt.mockResolvedValue(ok(undefined));
    const recovered = await f.adoption.recheck(actor, "1");
    expect(recovered.isOk() && recovered.value.status).toBe("verified");
  });
  it("does not instantiate the AWS adapter unless enabled", () => {
    expect(
      createSesDomainProvider({ enabled: false, ruleName: "" }),
    ).toBeUndefined();
  });
});
