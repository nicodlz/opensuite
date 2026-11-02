import { createReadinessService } from "@opensuite/core";
import { describe, expect, it } from "vitest";
import { buildServer } from "../src/server.ts";

const now = () => performance.now();
describe("mail import HTTP boundary", () => {
  it("checks origin and session before accepting a large request body", async () => {
    const app = await buildServer({
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
        actor: (headers) =>
          Promise.resolve(
            headers.get("cookie") === "owner"
              ? { id: "owner", email: "owner@example.test", role: "user" }
              : null,
          ),
      },
    });
    try {
      const headers = { "content-type": "application/json" };
      const request = (origin: string, cookie?: string) =>
        app.inject({
          method: "POST",
          url: "/mail/imports/create",
          headers: {
            ...headers,
            origin,
            ...(cookie === undefined ? {} : { cookie }),
          },
          payload: "{",
        });
      expect((await request("https://wrong.test")).statusCode).toBe(403);
      expect((await request("https://suite.example.test")).statusCode).toBe(
        401,
      );
      expect(
        (await request("https://suite.example.test", "owner")).statusCode,
      ).toBe(400);
      const attempts = await Promise.all(
        Array.from({ length: 4 }, () =>
          request("https://suite.example.test", "owner"),
        ),
      );
      expect(attempts.map((attempt) => attempt.statusCode)).toEqual([
        400, 400, 400, 400,
      ]);
      expect(
        (await request("https://suite.example.test", "owner")).statusCode,
      ).toBe(429);
      const report = await app.inject({
        method: "POST",
        url: "/mail/imports/report",
        headers: { origin: "https://suite.example.test", cookie: "owner" },
        payload: { accountId: "default", jobId: "job" },
      });
      expect(report.statusCode).toBe(503);
      expect(report.headers["cache-control"]).toBe("no-store");
    } finally {
      await app.close();
    }
  });
});
