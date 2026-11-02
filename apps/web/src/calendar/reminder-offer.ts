import type { CalendarEvent, EventContent } from "@opensuite/contracts";
import { isIosUninstalled, pushIsOn, supportsPush } from "../push/client.ts";
import type { NotificationOffer } from "../push/hook.ts";

/**
 * After the editor saves an event with a reminder, suggests notifications
 * on this device unless they are already on. Drags and quick creation keep
 * the reminder they had, so they do not ask.
 */
export function offerReminder(
  saved: CalendarEvent | null,
  content: EventContent,
  offer: (details: NotificationOffer) => void,
) {
  if (!saved) return;
  const reminder = saved.reminder ?? content.reminder;
  if (!reminder || reminder === "none") return;
  const details = {
    reason: "calendar-reminder",
    message: "Get this reminder on this device?",
  };
  if (isIosUninstalled()) offer(details);
  else if (supportsPush())
    void pushIsOn("calendar")
      .then((enabled) => {
        if (!enabled) offer(details);
        return undefined;
      })
      .catch(() => {});
}
