import { createReadinessService } from "@opensuite/core";
import type { OrganizerService } from "@opensuite/core/services/invitations-outbound";
import { ok, err } from "neverthrow";
import { describe, expect, it, vi } from "vitest";
import { buildServer } from "../src/server.ts";
import { createOrganizerAuthorization } from "../src/push-runtime.ts";

const id = "a1cc9eb1-0203-4949-9b2f-d6fe7768ce02";
const organize = vi.fn<OrganizerService["organize"]>((actor, input) =>
  Promise.resolve(
    input.accountId === "default" && actor.id === "owner"
      ? ok({ operationId: input.requestId, state: "pending", eventId: null })
      : err({ kind: "forbidden" }),
  ),
);
const service: OrganizerService = {
  organize,
  unverified: () => Promise.resolve(ok({ messageIds: [], nextCursor: null })),
  reconcile: (actor, accountId, operationId) =>
    Promise.resolve(
      actor.id === "owner" && accountId === "default"
        ? ok({
            operationId,
            state: "failed",
            eventId: "event",
            failedRecipients: [
              { email: "alice@example.test", reason: "sender_unavailable" },
            ],
          })
        : err({ kind: "forbidden" }),
    ),
  status: (actor, accountId) =>
    Promise.resolve(
      actor.id === "owner" && accountId === "default"
        ? ok({
            organizer: "owner@example.test",
            sequence: 1,
            cancelled: false,
            pendingOperationId: id,
            attendees: [],
          })
        : err({ kind: "forbidden" }),
    ),
  reply: () =>
    Promise.resolve(
      ok({
        senderStatus: "unverified",
        verificationPending: false,
        result: "unverified",
        from: [],
        occurrence: "master",
        event: {
          uid: "uid",
          recurrenceId: null,
          recurrenceIdTimeZone: null,
          sequence: 0,
          organizer: { email: "owner@example.test", name: null },
          attendees: [
            { email: "alice@example.test", name: null, partstat: "ACCEPTED" },
          ],
          title: "",
          description: "",
          location: "",
          start: null,
          end: null,
          timeZone: null,
          recurrence: [],
          meetingUrl: null,
        },
      }),
    ),
};
const origin = "https://suite.example.test";
const now = () => performance.now();
const input = {
  accountId: "default",
  requestId: id,
  eventId: null,
  organizer: "owner@example.test",
  attendees: ["alice@example.test"],
  cancel: false,
  event: {
    calendarId: "calendar",
    title: "Meeting",
    description: "",
    location: "",
    start: "2026-11-02T10:00:00.000Z",
    end: "2026-11-02T11:00:00.000Z",
    allDay: false,
    timeZone: "Europe/Lisbon",
    recurrence: "weekly",
  },
};

describe("organizer invitation HTTP boundary", () => {
  it("does not confuse sender lookup failures with revocation", async () => {
    const absent = { canSendAs: () => Promise.resolve(ok(null)) };
    const unavailable = {
      canSendAs: () => Promise.resolve(err({ kind: "unavailable" as const })),
    };
    await expect(
      createOrganizerAuthorization(unavailable, absent)(
        "owner",
        "alias@example.test",
      ),
    ).rejects.toThrow("Alias authorization unavailable");
    await expect(
      createOrganizerAuthorization(absent, unavailable)(
        "owner",
        "alias@example.test",
      ),
    ).rejects.toThrow("Address authorization unavailable");
    await expect(
      createOrganizerAuthorization(absent, absent)(
        "owner",
        "alias@example.test",
      ),
    ).resolves.toBeNull();
  });
  it("requires a session and same origin, validates input and scopes the account", async () => {
    const app = await buildServer({
      config: { logLevel: "silent" },
      monotonicMs: now,
      readiness: createReadinessService({
        probes: [],
        timeoutMs: 500,
        now: () => new Date(),
        monotonicMs: now,
      }),
      organizer: service,
      identity: {
        publicOrigin: origin,
        handler: () => Promise.resolve(new Response()),
        actor: (headers) =>
          Promise.resolve(
            headers.get("cookie") === "owner"
              ? { id: "owner", email: "owner@example.test", role: "user" }
              : null,
          ),
      },
    });
    const post = (payload: object, headers: Record<string, string>) =>
      app.inject({
        method: "POST",
        url: "/invitations/organize",
        payload,
        headers,
      });
    try {
      organize.mockClear();
      expect((await post(input, { origin })).statusCode).toBe(401);
      expect(
        (
          await post(input, {
            origin: "https://evil.example.test",
            cookie: "owner",
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (
          await post(
            { ...input, attendees: ["invalid"] },
            { origin, cookie: "owner" },
          )
        ).statusCode,
      ).toBe(400);
      expect(organize).not.toHaveBeenCalled();
      expect(
        (
          await post(
            { ...input, accountId: "other" },
            { origin, cookie: "owner" },
          )
        ).statusCode,
      ).toBe(403);
      const response = await post(input, { origin, cookie: "owner" });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        operationId: id,
        state: "pending",
        eventId: null,
      });
      expect(organize).toHaveBeenLastCalledWith(
        expect.objectContaining({ id: "owner" }),
        input,
      );
      const reply = await app.inject({
        method: "POST",
        url: "/invitations/organized/reply",
        headers: { origin, cookie: "owner" },
        payload: { accountId: "default", messageId: "message" },
      });
      expect(reply.json()).toMatchObject({
        senderStatus: "unverified",
        result: "unverified",
        event: { uid: "uid" },
      });
      const status = (accountId: string, headers: Record<string, string>) =>
        app.inject({
          method: "POST",
          url: "/invitations/organized/status",
          headers,
          payload: { accountId, eventId: "event" },
        });
      expect((await status("default", { origin })).statusCode).toBe(401);
      expect(
        (
          await status("default", {
            origin: "https://evil.example.test",
            cookie: "owner",
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (await status("other", { origin, cookie: "owner" })).statusCode,
      ).toBe(403);
      expect(
        (await status("default", { origin, cookie: "owner" })).json(),
      ).toMatchObject({
        pendingOperationId: id,
      });
      const reconciliation = await app.inject({
        method: "POST",
        url: "/invitations/organized/reconcile",
        headers: { origin, cookie: "owner" },
        payload: { accountId: "default", operationId: id },
      });
      expect(reconciliation.json()).toMatchObject({
        state: "failed",
        failedRecipients: [
          { email: "alice@example.test", reason: "sender_unavailable" },
        ],
      });
    } finally {
      await app.close();
    }
  });
});
