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
  passOrigin?: string,
  passStatusOptions?: ServerDependencies["passStatusOptions"],
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
    ...(passOrigin ? { passOrigin } : {}),
    ...(passStatusOptions ? { passStatusOptions } : {}),
  });
  return app;
}
afterEach(async () => {
  await app?.close();
  app = undefined;
});
describe("Pass status", () => {
  it("reports disabled without contacting a vault", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const response = await (
      await start(undefined, { fetcher })
    ).inject("/pass/status");
    expect(response.json()).toEqual({
      enabled: false,
      reachable: false,
      version: null,
      checkedAt: null,
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
    const server = await start("https://pass.example.test", { fetcher });
    const response = await server.inject("/pass/status");
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toMatchObject({
      enabled: true,
      reachable: true,
      version: "1.37.4",
    });
    await server.inject("/pass/status");
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls.map(([url]) => urlText(url)).toSorted()).toEqual([
      "https://pass.example.test/alive",
      "https://pass.example.test/api/config",
    ]);
    for (const [, init] of fetcher.mock.calls)
      expect(init).toMatchObject({ redirect: "error", credentials: "omit" });
    expect((await server.inject("/origins")).json()).toEqual({
      pass: "https://pass.example.test",
    });
  });
  it("keeps reachability when the version endpoint fails", async () => {
    const response = await (
      await start("https://pass.example.test", {
        fetcher: configFailureFetcher,
      })
    ).inject("/pass/status");
    expect(response.json()).toMatchObject({
      enabled: true,
      reachable: true,
      version: null,
    });
  });
  it("times out an unreachable vault without affecting readiness", async () => {
    const server = await start("https://pass.example.test", {
      fetcher: timeoutFetcher,
      timeoutMs: 30,
    });
    const started = Date.now();
    const response = await server.inject("/pass/status");
    expect(Date.now() - started).toBeLessThan(1000);
    expect(response.json()).toMatchObject({
      enabled: true,
      reachable: false,
      version: null,
    });
    expect((await server.inject("/ready")).statusCode).toBe(200);
  });
});
