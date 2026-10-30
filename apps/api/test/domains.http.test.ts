import { createReadinessService } from "@opensuite/core";
import type { ManagedDomain } from "@opensuite/contracts";
import type { DomainService } from "@opensuite/core/services/domains";
import { ok } from "neverthrow";
import { describe, expect, it, vi } from "vitest";
import { buildServer } from "../src/server.ts";

const domain: ManagedDomain & { stalwartId: string } = {
  id: "d1",
  stalwartId: "stalwart",
  name: "example.test",
  status: "pending",
  checkedAt: null,
  records: [],
  addresses: [],
};
const list = vi.fn<DomainService["list"]>(() => Promise.resolve(ok([domain])));
const add = vi.fn<DomainService["add"]>(() => Promise.resolve(ok(domain)));
const audit = vi.fn<
  (event: { userId: string | null; action: string }) => Promise<void>
>(() => Promise.resolve());
const service: DomainService = {
  list,
  add,
  recheck: () => Promise.resolve(ok(domain)),
  remove: () => Promise.resolve(ok(undefined)),
  addAddress: () => Promise.resolve(ok(domain)),
  removeAddress: () => Promise.resolve(ok(domain)),
};
const clock = () => performance.now();
const readiness = createReadinessService({
  probes: [],
  timeoutMs: 500,
  now: () => new Date(),
  monotonicMs: clock,
});
const origin = "https://suite.example.test";
async function server(role: "admin" | "user" | "none") {
  return buildServer({
    config: { logLevel: "silent" },
    monotonicMs: clock,
    readiness,
    domains: service,
    identity: {
      publicOrigin: origin,
      audit,
      handler: () => Promise.resolve(new Response()),
      actor: () =>
        Promise.resolve(
          role === "none"
            ? null
            : { id: "u", email: "user@example.test", role },
        ),
    },
  });
}
describe("domain API", () => {
  it("requires an authenticated administrator before reaching the service", async () => {
    await Promise.all(
      (["none", "user"] satisfies ("none" | "user")[]).map(async (role) => {
        const app = await server(role);
        const response = await app.inject({
          method: "GET",
          url: "/admin/domains",
        });
        expect(response.statusCode).toBe(role === "none" ? 401 : 403);
        await app.close();
      }),
    );
    expect(list).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledWith({
      userId: null,
      action: "admin.access_denied",
    });
    expect(audit).toHaveBeenCalledWith({
      userId: "u",
      action: "admin.access_denied",
    });
  });
  it("validates input and lets an admin add and recheck", async () => {
    const app = await server("admin");
    try {
      const bad = await app.inject({
        method: "POST",
        url: "/admin/domains",
        headers: { origin },
        payload: { name: "bad/domain" },
      });
      expect(bad.statusCode).toBe(400);
      const added = await app.inject({
        method: "POST",
        url: "/admin/domains",
        headers: { origin },
        payload: { name: "EXAMPLE.TEST" },
      });
      expect(added.statusCode).toBe(200);
      expect(add).toHaveBeenCalledWith(
        expect.objectContaining({ role: "admin" }),
        "example.test",
      );
      const checked = await app.inject({
        method: "POST",
        url: "/admin/domains/d1/recheck",
        headers: { origin },
        payload: {},
      });
      expect(checked.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });
});
