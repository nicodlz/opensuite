import { createReadinessService } from "@opensuite/core";
import type { InvitationService } from "@opensuite/core/services/invitations";
import { err, ok } from "neverthrow";
import { describe, expect, it, vi } from "vitest";
import { buildServer } from "../src/server.ts";

const requestId = "a1cc9eb1-0203-4949-9b2f-d6fe7768ce02";
const action = {
  accountId: "default",
  messageId: "message",
  calendarId: "calendar",
  requestId,
  action: "accept" as const,
  recurrenceId: null,
};
const act = vi.fn<InvitationService["act"]>((actor, input) =>
  Promise.resolve(
    input.accountId === "default"
      ? ok({ operationId: input.requestId, state: "sent", eventId: "event" })
      : err({ kind: "forbidden" }),
  ),
);
const confirm = vi.fn<InvitationService["confirm"]>((_actor, input) =>
  Promise.resolve(
    ok({ operationId: input.requestId, state: "sent", eventId: "event" }),
  ),
);
const service: InvitationService = {
  read: () => Promise.resolve(err({ kind: "not_found" })),
  act,
  confirm,
  reconcile: (_actor, _accountId, id) =>
    Promise.resolve(
      ok({ operationId: id, state: "pending", eventId: "event" }),
    ),
};
const origin = "https://suite.example.test";
const clock = () => performance.now();
const start = () =>
  buildServer({
    config: { logLevel: "silent" },
    monotonicMs: clock,
    readiness: createReadinessService({
      probes: [],
      timeoutMs: 500,
      now: () => new Date(),
      monotonicMs: clock,
    }),
    invitations: service,
    identity: {
      publicOrigin: origin,
      handler: () => Promise.resolve(new Response()),
      actor: (headers) =>
        Promise.resolve(
          headers.get("cookie") === "owner"
            ? { id: "owner", email: "alice@example.test", role: "user" }
            : null,
        ),
    },
  });

describe("invitation action HTTP boundary", () => {
  it("requires an authenticated same-origin actor and validates an explicit action", async () => {
    const app = await start();
    const post = (
      url: string,
      payload: object,
      headers: Record<string, string>,
    ) => app.inject({ method: "POST", url, payload, headers });
    try {
      act.mockClear();
      confirm.mockClear();
      expect(
        (await post("/invitations/act", action, { origin })).statusCode,
      ).toBe(401);
      expect(
        (
          await post("/invitations/act", action, {
            origin: "https://evil.example.test",
            cookie: "owner",
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (
          await post(
            "/invitations/act",
            { ...action, action: "send-anything" },
            { origin, cookie: "owner" },
          )
        ).statusCode,
      ).toBe(400);
      expect(act).not.toHaveBeenCalled();
      const response = await post("/invitations/act", action, {
        origin,
        cookie: "owner",
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        operationId: requestId,
        state: "sent",
        eventId: "event",
      });
      expect(act).toHaveBeenCalledWith(
        expect.objectContaining({ id: "owner" }),
        action,
      );
      expect(
        (
          await post(
            "/invitations/act",
            { ...action, accountId: "other" },
            { origin, cookie: "owner" },
          )
        ).statusCode,
      ).toBe(403);
      expect(
        (await post("/invitations/confirm", action, { origin })).statusCode,
      ).toBe(401);
      expect(
        (
          await post("/invitations/confirm", action, {
            origin: "https://evil.example.test",
            cookie: "owner",
          })
        ).statusCode,
      ).toBe(403);
      expect(confirm).not.toHaveBeenCalled();
      const confirmed = await post("/invitations/confirm", action, {
        origin,
        cookie: "owner",
      });
      expect(confirmed.statusCode).toBe(200);
      expect(confirm).toHaveBeenCalledWith(
        expect.objectContaining({ id: "owner" }),
        action,
      );
      const pending = await post(
        "/invitations/reconcile",
        { accountId: "default", operationId: requestId },
        { origin, cookie: "owner" },
      );
      expect(pending.json()).toEqual({
        operationId: requestId,
        state: "pending",
        eventId: "event",
      });
    } finally {
      await app.close();
    }
  });
});
