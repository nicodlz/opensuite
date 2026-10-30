import { calendarReminderNotifications } from "@opensuite/core/adapters/calendar-reminder-notifications";
import { createCalendarReminderSource } from "@opensuite/core/services/calendar-reminder-plan";
import { createCalendarReminders } from "@opensuite/core/services/calendar-reminders";
import type { DetailedNotificationDispatcher } from "@opensuite/core/services/notifications";
import type { MailCredentialStore } from "@opensuite/core/services/jmap-access";
import { createCalendarReminderStore, type PrismaClient } from "@opensuite/db";

export function startCalendarReminderJob(options: {
  db: PrismaClient;
  store: MailCredentialStore;
  origin: string;
  dispatcher: DetailedNotificationDispatcher;
  publicKey: string;
  onError: () => void;
}) {
  const job = createCalendarReminders({
    store: createCalendarReminderStore(options.db, options.publicKey),
    source: createCalendarReminderSource({
      store: options.store,
      origin: options.origin,
    }),
    sender: calendarReminderNotifications(options.dispatcher),
    onError: options.onError,
  });
  let planning: Promise<void> | undefined;
  let dispatching: Promise<void> | undefined;
  const plan = () => {
    if (planning) return;
    planning = job
      .plan()
      .catch(options.onError)
      .finally(() => {
        planning = undefined;
      });
  };
  const dispatch = () => {
    if (dispatching) return;
    dispatching = job
      .dispatch()
      .catch(options.onError)
      .finally(() => {
        dispatching = undefined;
      });
  };
  plan();
  dispatch();
  const planTimer = setInterval(plan, 60_000);
  const dispatchTimer = setInterval(dispatch, 10_000);
  return async () => {
    clearInterval(planTimer);
    clearInterval(dispatchTimer);
    await Promise.all([planning, dispatching]);
  };
}
