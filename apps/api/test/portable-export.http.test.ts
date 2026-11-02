import { createPortableExportAccess } from "../src/routes/portable-export.ts";
import { portableExportTools } from "@opensuite/core/adapters/portable-export";
import { createReadinessService } from "@opensuite/core";
import { createPortableExportService } from "@opensuite/core/services/portable-export";
import { err } from "neverthrow";
import { expect, it } from "vitest";
import { buildServer } from "../src/server.ts";

const now = () => performance.now();
const actor = (headers: Headers) =>
  Promise.resolve(
    headers.get("cookie") === "session"
      ? { id: "alice", email: "alice@example.test", role: "user" as const }
      : null,
  );
it("requires a live actor, trusted origin and ownership for exports", async () => {
  const service = createPortableExportService({
    tools: portableExportTools,
    origin: "http://127.0.0.1:1",
    store: { getForOwner: () => Promise.resolve(err({ kind: "not_found" })) },
  });
  const app = await buildServer({
    portableExport: createPortableExportAccess(service),
    config: { logLevel: "silent" },
    monotonicMs: now,
    readiness: createReadinessService({
      probes: [],
      timeoutMs: 100,
      now: () => new Date(),
      monotonicMs: now,
    }),
    identity: {
      publicOrigin: "https://suite.example.test",
      handler: () => Promise.resolve(new Response()),
      actor,
    },
  });
  try {
    const base = await app.listen({ port: 0, host: "127.0.0.1" });
    const call = (
      headers: Record<string, string>,
      data: unknown = { format: "ics", accountId: "other" },
    ) =>
      fetch(`${base}/portable-export`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(data),
      });
    expect((await call({ origin: "https://suite.example.test" })).status).toBe(
      401,
    );
    expect(
      (await call({ origin: "https://evil.example.test", cookie: "session" }))
        .status,
    ).toBe(403);
    const denied = await call({
      origin: "https://suite.example.test",
      cookie: "session",
    });
    expect(denied.status).toBe(403);
    expect(denied.headers.get("cache-control")).toContain("no-store");
    expect(
      (
        await call(
          { origin: "https://suite.example.test", cookie: "session" },
          { format: "eml", accountId: "default", ids: [] },
        )
      ).status,
    ).toBe(400);
  } finally {
    await app.close();
  }
});

it("exposes the export contract and limits repeated requests per user", async () => {
  const { ok } = await import("neverthrow");
  const service = {
    export: () =>
      Promise.resolve(
        ok({
          filename: "message.eml",
          contentType: "message/rfc822",
          content: "",
          exported: 0,
          warnings: [],
          failures: [{ id: "missing", reason: "Message not found." }],
        }),
      ),
  };
  const app = await buildServer({
    portableExport: createPortableExportAccess(service),
    config: { logLevel: "silent" },
    monotonicMs: now,
    readiness: createReadinessService({
      probes: [],
      timeoutMs: 100,
      now: () => new Date(),
      monotonicMs: now,
    }),
    identity: {
      publicOrigin: "https://suite.example.test",
      handler: () => Promise.resolve(new Response()),
      actor,
    },
  });
  try {
    const base = await app.listen({ port: 0, host: "127.0.0.1" });
    const request = () =>
      fetch(`${base}/portable-export`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://suite.example.test",
          cookie: "session",
        },
        body: JSON.stringify({
          format: "eml",
          accountId: "default",
          ids: ["missing"],
        }),
      });
    const first = await request();
    expect(first.status).toBe(200);
    expect(first.headers.get("cache-control")).toContain("no-store");
    expect(await first.json()).toMatchObject({
      exported: 0,
      failures: [{ id: "missing" }],
    });
    expect((await request()).status).toBe(200);
    expect((await request()).status).toBe(200);
    expect((await request()).status).toBe(200);
    expect((await request()).status).toBe(200);
    expect((await request()).status).toBe(429);
    const spec = await fetch(`${base}/openapi.json`).then((response) =>
      response.json(),
    );
    expect(spec).toHaveProperty("paths./portable-export.post");
  } finally {
    await app.close();
  }
});
