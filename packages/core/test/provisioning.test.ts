import { err, ok } from "neverthrow";
import { describe, expect, it, vi } from "vitest";
import {
  createProvisioningService,
  type ProvisioningPort,
  type ProvisioningStore,
} from "../src/services/provisioning.ts";

describe("mailbox provisioning recovery", () => {
  it("revokes old application credentials before retrying an interrupted issuance", async () => {
    const events: string[] = [];
    let active = false;
    let attempts = 0;
    const store: ProvisioningStore = {
      markDisabled: () => Promise.resolve(ok(undefined)),
      mailboxAccountId: () => Promise.resolve(ok("mail")),
      prepare: () => Promise.resolve(ok({ active, disabled: false })),
      beginIssuance: () => {
        events.push("issuing");
        return Promise.resolve(ok(undefined));
      },
      activate: () => {
        active = true;
        events.push("active");
        return Promise.resolve(ok(undefined));
      },
    };
    const port: ProvisioningPort = {
      ensureAccount: () =>
        Promise.resolve(ok({ accountId: "mail", address: "a@example.test" })),
      suspend: () => {
        events.push("suspend");
        return Promise.resolve(ok(undefined));
      },
      revokeApplicationPasswords: () => {
        events.push("revoke");
        return Promise.resolve(ok(undefined));
      },
      resume: () => {
        events.push("resume");
        return Promise.resolve(ok(undefined));
      },
      issue: () => {
        events.push("issue");
        attempts += 1;
        return Promise.resolve(
          attempts === 1
            ? err({ kind: "unavailable", message: "interrupted" })
            : ok({ id: "new", secret: "secret" }),
        );
      },
    };
    const service = createProvisioningService(store, port);
    expect((await service.ensure("user")).isErr()).toBe(true);
    expect((await service.ensure("user")).isOk()).toBe(true);
    expect(events).toEqual([
      "issuing",
      "suspend",
      "revoke",
      "resume",
      "issue",
      "issuing",
      "suspend",
      "revoke",
      "resume",
      "issue",
      "active",
    ]);
    expect((await service.ensure("user")).isOk()).toBe(true);
    const spy = vi.fn<ProvisioningStore["prepare"]>(() =>
      Promise.resolve(ok({ active: false, disabled: true })),
    );
    const disabled = createProvisioningService(
      { ...store, prepare: spy },
      port,
    );
    expect((await disabled.ensure("disabled")).isErr()).toBe(true);
    expect(spy).toHaveBeenCalledOnce();
  });
});
