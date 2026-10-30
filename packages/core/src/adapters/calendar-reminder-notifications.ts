import type {
  DetailedNotificationDispatcher,
  NotificationPayload,
} from "../services/notifications.ts";

/** Isolates calendar scheduling from the push transport's delivery result. */
export function calendarReminderNotifications(
  dispatcher: DetailedNotificationDispatcher,
) {
  return {
    async send(
      userId: string,
      payload: NotificationPayload,
      ttl: number,
    ): Promise<"sent" | "retry" | "invalid"> {
      const result = await dispatcher.notifyWithResult(
        userId,
        "calendar",
        payload,
        { ttl, urgency: "normal" },
      );
      if (result.outcome === "invalid") return "invalid";
      if (result.outcome === "delivered" || result.outcome === "duplicate")
        return "sent";
      return "retry";
    },
  };
}
