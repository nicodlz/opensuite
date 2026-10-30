// Jobs are deliberately processed sequentially to bound remote and database load.
/* oxlint-disable eslint/no-await-in-loop */
import { createHash } from "node:crypto";
import type { PlannedCalendarReminder } from "@opensuite/db";
import type { createCalendarReminderSource } from "./calendar-reminder-plan.ts";
import type { NotificationPayload } from "./notifications.ts";
import { toWall } from "./calendar-time.ts";

const MINUTE = 60_000;
export interface CalendarReminderStore {
  users(): PromiseLike<
    { id: string; email: string; calendarTimeZone?: string }[]
  >;
  acquire(
    userId: string,
    now: Date,
    until: Date,
    freshBefore?: Date,
  ): PromiseLike<string | null>;
  release(userId: string, owner: string): PromiseLike<void>;
  replace(
    userId: string,
    owner: string,
    now: Date,
    graceBefore: Date,
    planned: PlannedCalendarReminder[],
    expectedTimeZone?: string,
  ): PromiseLike<boolean>;
  claim(
    now: Date,
    until: Date,
    graceBefore: Date,
  ): PromiseLike<
    | (PlannedCalendarReminder & { id: string; userId: string; owner: string })
    | null
  >;
  finish(
    id: string,
    owner: string,
    state: "sent" | "skipped" | "retry",
    next: Date,
  ): PromiseLike<void>;
  skipExpired(before: Date): PromiseLike<void>;
  showDetails(userId: string): PromiseLike<boolean>;
  purgeFinished?(before: Date): PromiseLike<void>;
}
type Source = ReturnType<typeof createCalendarReminderSource>;
type Sender = {
  send(
    userId: string,
    payload: NotificationPayload,
    ttl: number,
  ): Promise<"sent" | "retry" | "invalid">;
};
export function createCalendarReminders(options: {
  store: CalendarReminderStore;
  source: Source;
  sender: Sender;
  now?: () => Date;
  graceMs?: number;
  onError?: () => void;
}) {
  const now = options.now ?? (() => new Date());
  const grace = options.graceMs ?? 15 * MINUTE;
  const error = options.onError ?? (() => {});
  return {
    async plan() {
      const users = await options.store.users();
      let index = 0;
      let failures = 0;
      const worker = async () => {
        while (index < users.length) {
          const user = users[index++];
          if (!user) continue;
          const start = now();
          let owner: string | null = null;
          try {
            owner = await options.store.acquire(
              user.id,
              start,
              new Date(start.getTime() + 5 * MINUTE),
              new Date(start.getTime() - 50_000),
            );
            if (!owner) continue;
            const from = new Date(start.getTime() - grace);
            const reminders = await options.source.read(
              user,
              from,
              new Date(start.getTime() + 48 * 60 * MINUTE),
            );
            if (
              !(await options.store.replace(
                user.id,
                owner,
                now(),
                from,
                reminders,
                user.calendarTimeZone,
              ))
            )
              failures++;
          } catch {
            failures++;
          } finally {
            if (owner) {
              try {
                await options.store.release(user.id, owner);
              } catch {
                failures++;
              }
            }
          }
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(4, users.length) }, () => worker()),
      );
      try {
        await options.store.purgeFinished?.(
          new Date(now().getTime() - 30 * 24 * 60 * MINUTE),
        );
      } catch {
        failures++;
      }
      if (failures) error();
    },
    async dispatch() {
      const start = now();
      await options.store.skipExpired(new Date(start.getTime() - grace));
      let failures = 0;
      const worker = async () => {
        for (;;) {
          const current = now();
          const reminder = await options.store.claim(
            current,
            new Date(current.getTime() + 5 * MINUTE),
            new Date(current.getTime() - grace),
          );
          if (!reminder) break;
          try {
            const details = await options.store.showDetails(reminder.userId);
            const suffix = JSON.stringify([
              reminder.uid,
              reminder.occurrenceId,
              reminder.occurrenceStart.toISOString(),
            ]);
            const tag = `cal:${createHash("sha256").update(suffix).digest("hex")}`;
            const time = new Intl.DateTimeFormat("en", {
              timeZone: reminder.timeZone,
              dateStyle: "medium",
              ...(reminder.allDay ? {} : { timeStyle: "short" }),
            }).format(reminder.occurrenceStart);
            const payload: NotificationPayload = {
              title: details
                ? reminder.title.slice(0, 300) || "Upcoming event"
                : "Upcoming event",
              ...(details
                ? {
                    body: [time, reminder.location.slice(0, 300)]
                      .filter(Boolean)
                      .join(" · "),
                  }
                : {}),
              url: `/calendar?event=${encodeURIComponent(reminder.occurrenceId)}&start=${encodeURIComponent(reminder.occurrenceStart.toISOString())}${reminder.allDay ? `&allDay=1&day=${new Date(toWall(reminder.occurrenceStart.getTime(), reminder.timeZone)).toISOString().slice(0, 10)}` : ""}`,
              tag,
              icon: "/icons/calendar-192.png",
            };
            const ttl = Math.max(
              60,
              Math.min(
                28 * 24 * 3600,
                Math.ceil(
                  (reminder.occurrenceStart.getTime() - current.getTime()) /
                    1000,
                ),
              ),
            );
            const result = await options.sender.send(
              reminder.userId,
              payload,
              ttl,
            );
            await options.store.finish(
              reminder.id,
              reminder.owner,
              result === "invalid" ? "skipped" : result,
              new Date(current.getTime() + MINUTE),
            );
          } catch {
            failures++;
            await options.store.finish(
              reminder.id,
              reminder.owner,
              "retry",
              new Date(current.getTime() + MINUTE),
            );
          }
        }
      };
      const results = await Promise.allSettled(
        Array.from({ length: 4 }, () => worker()),
      );
      failures += results.filter(
        (result) => result.status === "rejected",
      ).length;
      if (failures) error();
    },
  };
}
