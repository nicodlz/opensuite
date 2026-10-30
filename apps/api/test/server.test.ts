import { createReadinessService, type DependencyProbe } from "@opensuite/core";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { downProbe, upProbe } from "../../../test-support/probes.ts";
import { buildServer } from "../src/server.ts";

let app: FastifyInstance | undefined;
const now = () => performance.now();

const start = async (probes: DependencyProbe[] = []) => {
  let clock = 10_000;
  app = await buildServer({
    config: { logLevel: "silent" },
    readiness: createReadinessService({
      probes,
      timeoutMs: 500,
      now: () => new Date("2026-10-29T12:00:00.000Z"),
      monotonicMs: () => clock,
    }),
    monotonicMs: () => clock,
  });
  clock += 42_500;
  return app;
};

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("GET /health", () => {
  it("reports liveness with uptime", async () => {
    const response = await (await start()).inject("/health");
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok", uptimeSeconds: 42 });
  });

  it("stays live while a dependency is down", async () => {
    const server = await start([downProbe("database", "refused")]);
    expect((await server.inject("/health")).statusCode).toBe(200);
  });

  it("rejects unexpected query parameters", async () => {
    const response = await (await start()).inject("/health?debug=1");
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      code: "BAD_REQUEST",
      data: { issues: [{ code: "unrecognized_keys", keys: ["debug"] }] },
    });
  });
});

describe("GET /ready", () => {
  it("is ready when every declared dependency is up", async () => {
    const response = await (
      await start([upProbe("database")])
    ).inject("/ready");
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: "ready",
      checkedAt: "2026-10-29T12:00:00.000Z",
      dependencies: [{ name: "database", status: "up", durationMs: 0 }],
    });
  });

  it("answers 503 with per-dependency status when degraded", async () => {
    const server = await start([
      upProbe("database"),
      downProbe("mail-server", "secret-host:8080 refused"),
    ]);
    const response = await server.inject("/ready");
    expect(response.statusCode).toBe(503);
    const body = response.json<{ code: string; data: unknown }>();
    expect(body.code).toBe("NOT_READY");
    expect(body.data).toEqual({
      status: "not_ready",
      checkedAt: "2026-10-29T12:00:00.000Z",
      dependencies: [
        { name: "database", status: "up", durationMs: 0 },
        { name: "mail-server", status: "down", durationMs: 0 },
      ],
    });
    // Failure details are logged server-side, not disclosed to callers.
    expect(response.body).not.toContain("secret-host");
  });
});

describe("routing and contract", () => {
  it("answers unknown routes with a JSON 404", async () => {
    const response = await (await start()).inject("/does-not-exist");
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      code: "NOT_FOUND",
      message: "No such route",
    });
  });

  it("rejects a method the contract does not declare", async () => {
    const response = await (
      await start()
    ).inject({
      method: "POST",
      url: "/health",
      payload: {},
    });
    expect(response.statusCode).toBe(404);
  });

  it("serves an OpenAPI document generated from the contract", async () => {
    const response = await (await start()).inject("/openapi.json");
    expect(response.statusCode).toBe(200);
    const document = response.json<{
      openapi: string;
      paths: Record<string, Record<string, { responses: object }>>;
    }>();
    expect(document.openapi).toMatch(/^3\.1/);
    expect(Object.keys(document.paths)).toEqual(
      expect.arrayContaining([
        "/health",
        "/ready",
        "/account/me",
        "/admin/accounts",
      ]),
    );
    expect(
      Object.keys(document.paths["/ready"]?.["get"]?.responses ?? {}),
    ).toEqual(expect.arrayContaining(["200", "503"]));
  });
});

it("logs safe error details without disclosing exception secrets", async () => {
  app = await buildServer({
    config: { logLevel: "silent" },
    monotonicMs: now,
    readiness: createReadinessService({
      probes: [],
      timeoutMs: 500,
      now: () => new Date(),
      monotonicMs: now,
    }),
    identity: {
      publicOrigin: "https://suite.example.test",
      handler: () => Promise.resolve(new Response()),
      actor: () =>
        Promise.resolve({
          id: "admin",
          email: "admin@example.test",
          role: "admin",
        }),
    },
    accounts: {
      mailbox: () => {
        throw new Error("unused");
      },
      list: () => {
        throw new TypeError("password=very-secret");
      },
      disable: () => {
        throw new Error("unused");
      },
    },
  });
  let logged: unknown;
  app.addHook("onRequest", (request, _reply, done) => {
    vi.spyOn(request.log, "error").mockImplementation((...args: unknown[]) => {
      logged = args[0];
    });
    done();
  });
  expect((await app.inject("/admin/accounts")).statusCode).toBe(500);
  expect(JSON.stringify(logged)).not.toContain("very-secret");
  expect(logged).toMatchObject({
    error: { name: "TypeError", message: "[redacted]" },
  });
  expect(JSON.stringify(logged)).toContain("stack");
});

it("forbids caching of the origin map", async () => {
  const response = await (await start()).inject("/origins");
  expect(response.statusCode).toBe(200);
  expect(response.headers["cache-control"]).toBe("no-store");
  expect(response.json()).toEqual({});
});
