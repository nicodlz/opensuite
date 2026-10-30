import { describe, expect, it, vi } from "vitest";
import { calendarReminderNotifications } from "@opensuite/core/adapters/calendar-reminder-notifications";
import type { DetailedNotificationDispatcher } from "@opensuite/core/services/notifications";

const payload = {
  title: "Meeting",
  url: "/calendar",
  tag: "cal:uid:occurrence",
};
describe("calendar push adapter", () => {
  it("passes the event lifetime and distinguishes delivery, retry and invalid payloads", async () => {
    const notifyWithResult =
      vi.fn<DetailedNotificationDispatcher["notifyWithResult"]>();
    const dispatcher: DetailedNotificationDispatcher = {
      notify: () => Promise.resolve(),
      notifyWithResult,
    };
    const sender = calendarReminderNotifications(dispatcher);
    notifyWithResult.mockResolvedValueOnce({
      outcome: "delivered",
      delivered: 1,
      failed: 0,
    });
    notifyWithResult.mockResolvedValueOnce({
      outcome: "failed",
      delivered: 0,
      failed: 1,
    });
    notifyWithResult.mockResolvedValueOnce({
      outcome: "no_subscriptions",
      delivered: 0,
      failed: 0,
    });
    notifyWithResult.mockResolvedValueOnce({
      outcome: "invalid",
      delivered: 0,
      failed: 0,
    });
    notifyWithResult.mockResolvedValueOnce({
      outcome: "duplicate",
      delivered: 0,
      failed: 0,
    });
    expect(await sender.send("user", payload, 3600)).toBe("sent");
    expect(notifyWithResult).toHaveBeenCalledWith("user", "calendar", payload, {
      ttl: 3600,
      urgency: "normal",
    });
    expect(await sender.send("user", payload, 3600)).toBe("retry");
    expect(await sender.send("user", payload, 3600)).toBe("retry");
    expect(await sender.send("user", payload, 3600)).toBe("invalid");
    expect(await sender.send("user", payload, 3600)).toBe("sent");
  });
});
