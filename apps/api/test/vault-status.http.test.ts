import { createReadinessService } from "@opensuite/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer, type ServerDependencies } from "../src/server.ts";

const urlText = (url: Parameters<typeof fetch>[0]) =>
  typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
const configFailureFetcher: typeof fetch = (url) =>
  urlText(url).endsWith("/alive")
    ? Promise.resolve(new Response("ok"))
    : Promise.reject(new Error("unavailable"));
const timeoutFetcher: typeof fetch = (_url, init) =>
  new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new Error("timeout")));
  });
let app: FastifyInstance | undefined;
async function start(
  vaultOrigin?: string,
  vaultStatusOptions?: ServerDependencies["vaultStatusOptions"],
  identity?: ServerDependencies["identity"],
) {
  app = await buildServer({
    config: { logLevel: "silent" },
    readiness: createReadinessService({
      probes: [],
      timeoutMs: 500,
      now: () => new Date(),
      monotonicMs: () => performance.now(),
    }),
    monotonicMs: () => performance.now(),
    ...(identity ? { identity } : {}),
    ...(vaultOrigin ? { vaultOrigin } : {}),
    ...(vaultStatusOptions ? { vaultStatusOptions } : {}),
  });
  return app;
}
afterEach(async () => {
  await app?.close();
  app = undefined;
});
describe("Vault status", () => {
  it("does not expose the former status route", async () => {
    const server = await start();
    expect((await server.inject("/pass/status")).statusCode).toBe(404);
  });
  it("reports disabled without contacting a vault", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const response = await (
      await start(undefined, { fetcher })
    ).inject("/vault/status");
    expect(response.json()).toEqual({
      enabled: false,
      reachable: false,
    });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("reads only public status endpoints and caches the result", async () => {
    const fetcher = vi.fn<typeof fetch>((url) =>
      Promise.resolve(
        new Response(
          urlText(url).endsWith("/alive")
            ? "ok"
            : JSON.stringify({ version: "1.37.4" }),
        ),
      ),
    );
    const identity: NonNullable<ServerDependencies["identity"]> = {
      publicOrigin: "https://suite.example.test",
      handler: () => Promise.resolve(new Response()),
      actor: (headers) =>
        Promise.resolve(
          headers.get("cookie") === "session=valid"
            ? { id: "user", email: "user@example.test", role: "user" }
            : null,
        ),
    };
    const server = await start(
      "https://vault.example.test",
      { fetcher },
      identity,
    );
    const anonymous = await server.inject("/vault/status");
    expect(anonymous.json()).toEqual({ enabled: true, reachable: true });
    const response = await server.inject({
      url: "/vault/status",
      headers: { cookie: "session=valid" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toMatchObject({
      enabled: true,
      reachable: true,
      version: "1.37.4",
    });
    expect((await server.inject("/vault/status")).json()).not.toHaveProperty(
      "version",
    );
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls.map(([url]) => urlText(url)).toSorted()).toEqual([
      "https://vault.example.test/alive",
      "https://vault.example.test/api/config",
    ]);
    for (const [, init] of fetcher.mock.calls)
      expect(init).toMatchObject({ redirect: "error", credentials: "omit" });
    expect((await server.inject("/origins")).json()).toEqual({
      vault: "https://vault.example.test",
    });
  });
  it("keeps reachability when the version endpoint fails", async () => {
    const response = await (
      await start("https://vault.example.test", {
        fetcher: configFailureFetcher,
      })
    ).inject("/vault/status");
    expect(response.json()).toMatchObject({
      enabled: true,
      reachable: true,
    });
  });
  it("cancels a failed configuration response body", async () => {
    const cancel = vi.fn<() => void>();
    const fetcher: typeof fetch = (url) =>
      Promise.resolve(
        urlText(url).endsWith("/alive")
          ? new Response("ok")
          : new Response(new ReadableStream({ cancel }), { status: 503 }),
      );
    const server = await start("https://vault.example.test", { fetcher });
    expect((await server.inject("/vault/status")).statusCode).toBe(200);
    expect(cancel).toHaveBeenCalledOnce();
  });
  it("times out an unreachable vault without affecting readiness", async () => {
    const server = await start("https://vault.example.test", {
      fetcher: timeoutFetcher,
      timeoutMs: 30,
    });
    const started = Date.now();
    const response = await server.inject("/vault/status");
    expect(Date.now() - started).toBeLessThan(1000);
    expect(response.json()).toMatchObject({
      enabled: true,
      reachable: false,
    });
    expect((await server.inject("/ready")).statusCode).toBe(200);
  });
});
