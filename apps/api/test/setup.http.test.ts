import { createReadinessService } from "@opensuite/core";
import type { SetupStatus } from "@opensuite/contracts";
import { err, ok } from "neverthrow";
import type { DomainService } from "@opensuite/core/services/domains";
import { describe, expect, it, vi } from "vitest";
import { buildServer } from "../src/server.ts";

const origin = "https://suite.example.test";
const clock = () => performance.now();
const readiness = createReadinessService({
  probes: [],
  timeoutMs: 500,
  now: () => new Date(),
  monotonicMs: clock,
});
const status: SetupStatus = {
  database: "ready",
  stalwart: "ready",
  drive: "ready",
  objectStorage: "ready",
  relay: "unknown",
  backup: "unknown",
  backupAgeSeconds: null,
  mailDomain: "example.test",
};
const input = {
  email: "new@example.test",
  name: "New User",
  password: "a-long-password",
};
async function start(role: "admin" | "user" | "none") {
  let created = false;
  const handler = vi.fn<(request: Request) => Promise<Response>>((request) => {
    created = true;
    expect(request.headers.get("cookie")).toBeNull();
    return Promise.resolve(Response.json({ user: { id: "new-user" } }));
  });
  const domain = {
    id: "domain",
    name: "example.test",
    status: "pending",
    checkedAt: null,
    records: [],
    addresses: [],
    stalwartId: "s",
  } satisfies {
    id: string;
    name: string;
    status: "pending";
    checkedAt: null;
    records: [];
    addresses: [];
    stalwartId: string;
  };
  const addAddress = vi.fn<DomainService["addAddress"]>(() =>
    Promise.resolve(ok(domain)),
  );
  const domains: DomainService = {
    list: () => Promise.resolve(ok([domain])),
    addAddress,
    add: () => Promise.resolve(ok(domain)),
    recheck: () => Promise.resolve(ok(domain)),
    remove: () => Promise.resolve(ok(undefined)),
    removeAddress: () => Promise.resolve(ok(domain)),
  };
  const app = await buildServer({
    config: { logLevel: "silent" },
    readiness,
    monotonicMs: clock,
    setupStatus: () => Promise.resolve(status),
    domains,
    identity: {
      publicOrigin: origin,
      mailDomain: "example.test",
      handler,
      actor: () =>
        Promise.resolve(
          role === "none"
            ? null
            : { id: "actor", email: "admin@example.test", role },
        ),
      userIdForEmail: () => Promise.resolve(created ? "new-user" : null),
    },
  });
  return { app, handler, addAddress };
}
describe("setup admin routes", () => {
  it("denies anonymous and non-admin users before doing work", async () => {
    await Promise.all(
      (["none", "user"] satisfies ("none" | "user")[]).map(async (role) => {
        const { app, handler } = await start(role);
        try {
          expect(
            (await app.inject({ method: "GET", url: "/admin/setup/status" }))
              .statusCode,
          ).toBe(role === "none" ? 401 : 403);
          expect(
            (
              await app.inject({
                method: "POST",
                url: "/admin/setup/users",
                headers: { origin },
                payload: input,
              })
            ).statusCode,
          ).toBe(role === "none" ? 401 : 403);
          expect(handler).not.toHaveBeenCalled();
        } finally {
          await app.close();
        }
      }),
    );
  });
  it("validates the domain and creates without forwarding the admin session", async () => {
    const { app, handler, addAddress } = await start("admin");
    try {
      expect(
        (
          await app.inject({ method: "GET", url: "/admin/setup/status" })
        ).json(),
      ).toEqual(status);
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/admin/setup/users",
            headers: { origin },
            payload: { ...input, email: "x@other.test" },
          })
        ).statusCode,
      ).toBe(400);
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/admin/setup/users",
            headers: { origin },
            payload: { ...input, password: "short" },
          })
        ).statusCode,
      ).toBe(400);
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/admin/setup/users",
            headers: { origin, cookie: "session=secret" },
            payload: input,
          })
        ).statusCode,
      ).toBe(200);
      expect(handler).toHaveBeenCalledOnce();
      expect(addAddress).toHaveBeenCalledWith(
        expect.objectContaining({ role: "admin" }),
        {
          domainId: "domain",
          userId: "new-user",
          localPart: "new",
          isAlias: false,
        },
      );
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/admin/setup/users",
            headers: { origin },
            payload: input,
          })
        ).statusCode,
      ).toBe(409);
    } finally {
      await app.close();
    }
  });
  it("reports partial failure if primary address registration fails", async () => {
    const { app, addAddress } = await start("admin");
    addAddress.mockResolvedValueOnce(
      err({ kind: "unavailable", message: "failed" }),
    );
    try {
      const response = await app.inject({
        method: "POST",
        url: "/admin/setup/users",
        headers: { origin },
        payload: input,
      });
      expect(response.statusCode).toBe(503);
      expect(addAddress).toHaveBeenCalledOnce();
      const retry = await app.inject({
        method: "POST",
        url: "/admin/setup/users",
        headers: { origin },
        payload: input,
      });
      expect(retry.statusCode).toBe(409);
    } finally {
      await app.close();
    }
  });
});
