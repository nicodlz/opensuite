import { createReadinessService } from "@opensuite/core";
import type { InvitationService } from "@opensuite/core/services/invitations";
import { err, ok } from "neverthrow";
import { describe, expect, it } from "vitest";
import { buildServer } from "../src/server.ts";

const calls: string[] = [];
const service: InvitationService = {
  act: () => Promise.resolve(err({ kind: "unavailable" })),
  confirm: () => Promise.resolve(err({ kind: "unavailable" })),
  reconcile: () => Promise.resolve(err({ kind: "unavailable" })),
  read: (actor, accountId, messageId) => {
    calls.push(`${actor.id}:${accountId}:${messageId}`);
    return Promise.resolve(
      accountId === "default"
        ? ok({ method: "REQUEST", senderStatus: "unverified", events: [] })
        : err({ kind: "forbidden" }),
    );
  },
};
const start = (invitationService: InvitationService = service) =>
  buildServer({
    config: { logLevel: "silent" },
    monotonicMs: () => performance.now(),
    readiness: createReadinessService({
      probes: [],
      timeoutMs: 500,
      now: () => new Date(),
      monotonicMs: () => performance.now(),
    }),
    invitations: invitationService,
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

describe("invitation API", () => {
  it("requires a session and same origin, scopes the read and never sends a reply", async () => {
    const app = await start();
    const payload = { accountId: "default", messageId: "message" };
    const post = (headers: Record<string, string>, body = payload) =>
      app.inject({
        method: "POST",
        url: "/invitations/read",
        headers,
        payload: body,
      });
    try {
      calls.length = 0;
      const origin = "https://suite.example.test";
      expect((await post({ origin })).statusCode).toBe(401);
      expect(
        (await post({ origin: "https://evil.example.test", cookie: "owner" }))
          .statusCode,
      ).toBe(403);
      expect(calls).toEqual([]);
      const response = await post({ origin, cookie: "owner" });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        method: "REQUEST",
        senderStatus: "unverified",
        events: [],
      });
      expect(calls).toEqual(["owner:default:message"]);
      expect(
        (
          await post(
            { origin, cookie: "owner" },
            { ...payload, accountId: "other" },
          )
        ).statusCode,
      ).toBe(403);
      expect(
        (await post({ origin, cookie: "owner" }, { ...payload, messageId: "" }))
          .statusCode,
      ).toBe(400);
    } finally {
      await app.close();
    }
  });
  it("returns a documented rate-limit error for a blocked RSVP", async () => {
    const app = await start({
      ...service,
      act: () => Promise.resolve(err({ kind: "rate_limited" })),
    });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/invitations/act",
        headers: { origin: "https://suite.example.test", cookie: "owner" },
        payload: {
          accountId: "default",
          messageId: "message",
          calendarId: "calendar",
          requestId: "a20a4846-51e8-4d9a-9dfc-4c4ba1f1d5dc",
          action: "accept",
          recurrenceId: null,
        },
      });
      expect(response.statusCode).toBe(429);
      expect(response.json()).toMatchObject({ code: "TOO_MANY_REQUESTS" });
    } finally {
      await app.close();
    }
  });
});
