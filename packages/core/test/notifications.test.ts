/* oxlint-disable typescript/require-await, typescript/unbound-method */
import { describe, expect, it, vi } from "vitest";
import {
  createNotificationDispatcher,
  type NotificationStore,
  type PushSubscriptionRecord,
} from "../src/services/notifications.ts";

function fixture() {
  const tags = new Set<string>();
  const records: PushSubscriptionRecord[] = [
    {
      id: "a",
      endpoint: "https://fcm.googleapis.com/a",
      p256dh: "key",
      auth: "auth",
      failureCount: 0,
    },
    {
      id: "b",
      endpoint: "https://fcm.googleapis.com/b",
      p256dh: "key",
      auth: "auth",
      failureCount: 2,
    },
  ];
  const store: NotificationStore = {
    claim: async (user, product, tag) => {
      const key = `${user}:${product}:${tag}`;
      if (tags.has(key)) return false;
      tags.add(key);
      return true;
    },
    release: async (user, product, tag) => {
      tags.delete(`${user}:${product}:${tag}`);
    },
    showDetails: vi.fn<NotificationStore["showDetails"]>(async () => false),
    eligible: vi.fn<NotificationStore["eligible"]>(async () => records),
    success: vi.fn<NotificationStore["success"]>(async () => {}),
    purge: vi.fn<NotificationStore["purge"]>(async () => {}),
    failure: vi.fn<NotificationStore["failure"]>(async () => {}),
  };
  const send = vi.fn<
    (sub: PushSubscriptionRecord, body: string) => Promise<void>
  >(async (_sub: PushSubscriptionRecord, _body: string) => {});
  return {
    store,
    send,
    dispatcher: createNotificationDispatcher(
      store,
      { send },
      () => new Date("2026-01-01T00:00:00Z"),
    ),
  };
}
const payload = {
  title: "Alice",
  body: "Subject",
  url: "/mail",
  tag: "message-1",
};
describe("notification dispatcher", () => {
  it("deduplicates tags per user and product and hides mail details", async () => {
    const { dispatcher, send } = fixture();
    await dispatcher.notify("alice", "mail", payload);
    await dispatcher.notify("alice", "mail", payload);
    expect(send).toHaveBeenCalledTimes(2);
    expect(JSON.parse(send.mock.calls[0]?.[1] ?? "")).toEqual({
      title: "New message",
      url: "/mail",
      tag: "message-1",
    });
    await dispatcher.notify("bob", "mail", payload);
    await dispatcher.notify("alice", "calendar", payload);
    expect(send).toHaveBeenCalledTimes(6);
    expect(JSON.parse(send.mock.calls[4]?.[1] ?? "")).toEqual(payload);
  });
  it("purges expired endpoints and backs off transient failures", async () => {
    const { store, send, dispatcher } = fixture();
    send.mockImplementation(async (sub) => {
      throw { statusCode: sub.id === "a" ? 410 : 503 };
    });
    await dispatcher.notify("alice", "calendar", payload);
    expect(store.purge).toHaveBeenCalledWith("a");
    expect(store.failure).toHaveBeenCalledWith(
      "b",
      new Date("2026-01-01T00:00:00Z"),
      new Date("2026-01-01T00:04:00Z"),
    );
  });
  it("releases a failed claim so the same tag can be retried", async () => {
    const { dispatcher, send } = fixture();
    send
      .mockRejectedValueOnce({ statusCode: 503 })
      .mockRejectedValueOnce({ statusCode: 503 });
    expect(
      await dispatcher.notifyWithResult("alice", "calendar", payload),
    ).toMatchObject({ outcome: "failed", delivered: 0, failed: 2 });
    expect(
      await dispatcher.notifyWithResult("alice", "calendar", payload, {
        ttl: 3600,
        urgency: "high",
      }),
    ).toMatchObject({ outcome: "delivered", delivered: 2 });
    expect(send).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.any(String),
      { ttl: 3600, urgency: "high" },
    );
    expect(
      (await dispatcher.notifyWithResult("alice", "calendar", payload)).outcome,
    ).toBe("duplicate");
  });
  it.each([401, 403, 404, 410])(
    "purges status %i and logs only safe details",
    async (status) => {
      const { store } = fixture();
      const log =
        vi.fn<
          (event: {
            product: "calendar" | "mail" | "drive";
            status: number | null;
          }) => void
        >();
      const dispatcher = createNotificationDispatcher(
        store,
        {
          send: () =>
            Promise.reject({
              statusCode: status,
              endpoint: "secret-endpoint",
              body: "secret-body",
            }),
        },
        () => new Date(),
        log,
      );
      const result = await dispatcher.notifyWithResult(
        "alice",
        "calendar",
        payload,
      );
      expect(result).toMatchObject({
        outcome: "failed",
        delivered: 0,
        failed: 2,
      });
      expect(store.purge).toHaveBeenCalledTimes(2);
      expect(log).toHaveBeenCalledWith({ product: "calendar", status });
      expect(JSON.stringify(log.mock.calls)).not.toContain("secret");
    },
  );
  it("reports invalid data without sending", async () => {
    const { dispatcher } = fixture();
    expect(
      await dispatcher.notifyWithResult("alice", "calendar", {
        ...payload,
        url: "//evil",
      }),
    ).toMatchObject({ outcome: "invalid", delivered: 0, failed: 0 });
    expect(
      await dispatcher.notifyWithResult("alice", "calendar", payload, {
        ttl: -1,
      }),
    ).toMatchObject({ outcome: "invalid" });
  });
  it("rejects unsafe or oversized payloads before sending", async () => {
    const { dispatcher, send } = fixture();
    await expect(
      dispatcher.notify("alice", "calendar", {
        ...payload,
        url: "//evil.test",
      }),
    ).rejects.toThrow("Invalid notification payload or options");
    await expect(
      dispatcher.notify("alice", "calendar", {
        ...payload,
        body: "x".repeat(4000),
      }),
    ).rejects.toThrow("Notification payload too large");
    expect(send).not.toHaveBeenCalled();
  });
});
