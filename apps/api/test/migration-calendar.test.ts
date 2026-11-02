import { createReadinessService } from "@opensuite/core";
import { createCalendarService } from "@opensuite/core/services/calendar";
import type { CalendarImportService } from "@opensuite/core/services/migration-calendar";
import { err, ok } from "neverthrow";
import { describe, expect, it } from "vitest";
import { buildServer } from "../src/server.ts";

const calls: string[] = [];
const actions: unknown[] = [];
const job = {
  id: "job",
  accountId: "account",
  calendarId: "calendar",
  confirmed: false,
  abandoned: false,
  previewCounts: { new: 0, update: 0, duplicate: 0, conflict: 0, invalid: 0 },
  progress: {
    total: 0,
    completed: 0,
    imported: 0,
    duplicate: 0,
    failed: 0,
    abandoned: 0,
  },
  items: [],
};
const migration: CalendarImportService = {
  preview: (actor) => {
    calls.push(actor.id);
    return Promise.resolve(ok(job));
  },
  list: () => Promise.resolve(ok({ jobs: [job] })),
  get: () => Promise.resolve(ok(job)),
  confirm: (actor, id) => {
    actions.push({ action: "confirm", actor: actor.id, id });
    return Promise.resolve(ok({ ...job, confirmed: true }));
  },
  recover: (actor, id, input) => {
    actions.push({ actor: actor.id, id, input });
    return Promise.resolve(ok(job));
  },
  resume: () => Promise.resolve(ok({ ...job, confirmed: true })),
  delete: () => Promise.resolve(ok({ success: true as const })),
};
const now = () => performance.now();
const start = () =>
  buildServer({
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
    calendar: createCalendarService({
      origin: "http://example.test",
      store: { getForOwner: () => Promise.resolve(err({ kind: "forbidden" })) },
      migration,
    }),
  });
describe("calendar import API", () => {
  it("requires a same-origin session and rejects oversized requests before dispatch", async () => {
    const app = await start();
    const input = {
      accountId: "default",
      calendarId: "calendar",
      files: [{ name: "x.ics", content: "calendar" }],
    };
    try {
      calls.length = 0;
      const send = (headers: Record<string, string>, payload: object) =>
        app.inject({
          method: "POST",
          url: "/migration/calendar/preview",
          headers,
          payload,
        });
      expect(
        (await send({ origin: "https://suite.example.test" }, input))
          .statusCode,
      ).toBe(401);
      expect(
        (
          await send(
            { origin: "https://evil.example.test", cookie: "owner" },
            input,
          )
        ).statusCode,
      ).toBe(403);
      expect(
        (
          await send(
            { origin: "https://suite.example.test", cookie: "owner" },
            {
              ...input,
              files: [{ name: "huge.ics", content: "x".repeat(1_000_001) }],
            },
          )
        ).statusCode,
      ).toBe(413);
      expect(calls).toEqual([]);
      expect(
        (
          await send(
            { origin: "https://suite.example.test", cookie: "owner" },
            input,
          )
        ).json(),
      ).toEqual(job);
      expect(calls).toEqual(["owner"]);
      const ownerHeaders = {
        origin: "https://suite.example.test",
        cookie: "owner",
      };
      expect((await send(ownerHeaders, input)).statusCode).toBe(200);
      expect((await send(ownerHeaders, input)).statusCode).toBe(200);
      expect((await send(ownerHeaders, input)).statusCode).toBe(429);
      expect(calls).toEqual(["owner", "owner", "owner"]);
    } finally {
      await app.close();
    }
  });
  it("requires authentication and forwards explicit confirmation and recovery choices", async () => {
    const app = await start();
    const headers = { origin: "https://suite.example.test", cookie: "owner" };
    const send = (path: string, payload: object, requestHeaders = headers) =>
      app.inject({
        method: "POST",
        url: `/migration/calendar/${path}`,
        headers: requestHeaders,
        payload,
      });
    try {
      actions.length = 0;
      expect(
        (
          await send(
            "confirm",
            { jobId: "job" },
            { origin: headers.origin, cookie: "" },
          )
        ).statusCode,
      ).toBe(401);
      expect(
        (await send("recover", { jobId: "job", action: "retarget" }))
          .statusCode,
      ).toBe(400);
      expect(actions).toEqual([]);
      const confirmation: unknown = (
        await send("confirm", { jobId: "job" })
      ).json();
      expect(confirmation).toMatchObject({ confirmed: true });
      expect(
        (
          await send("recover", {
            jobId: "job",
            action: "retarget",
            calendarId: "replacement",
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (await send("recover", { jobId: "job", action: "abandon" })).statusCode,
      ).toBe(200);
      expect(actions).toEqual([
        { action: "confirm", actor: "owner", id: "job" },
        {
          actor: "owner",
          id: "job",
          input: {
            jobId: "job",
            action: "retarget",
            calendarId: "replacement",
          },
        },
        {
          actor: "owner",
          id: "job",
          input: { jobId: "job", action: "abandon" },
        },
      ]);
    } finally {
      await app.close();
    }
  });
});
