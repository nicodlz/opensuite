import { ReminderSchema, type Reminder } from "@opensuite/contracts";

const offsets: Record<Exclude<Reminder, "none" | "custom">, string> = {
  "at-time": "PT0S",
  "5m": "-PT5M",
  "10m": "-PT10M",
  "15m": "-PT15M",
  "30m": "-PT30M",
  "1h": "-PT1H",
  "1d": "-P1D",
};
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Describe a single simple start-relative display alert without discarding other alarms. */
export function reminderOf(alerts: unknown): Reminder {
  if (alerts === null || alerts === undefined) return "none";
  if (!isRecord(alerts)) return "custom";
  const list = Object.values(alerts);
  if (list.length === 0) return "none";
  if (list.length !== 1 || !isRecord(list[0])) return "custom";
  const alert = list[0];
  if (alert["action"] !== "display" || !isRecord(alert["trigger"]))
    return "custom";
  const trigger = alert["trigger"];
  if (
    trigger["@type"] !== "OffsetTrigger" ||
    (trigger["relativeTo"] !== undefined && trigger["relativeTo"] !== "start")
  )
    return "custom";
  const match = ReminderSchema.safeParse(
    Object.entries(offsets).find(
      ([, offset]) => offset === trigger["offset"],
    )?.[0],
  );
  return match.success ? match.data : "custom";
}

/** JSCalendar alerts are translated by Stalwart to RFC 5545 VALARM. */
export function reminderAlerts(
  reminder: Reminder | undefined,
  alarmId = "reminder",
) {
  if (reminder === undefined || reminder === "custom") return undefined;
  if (reminder === "none") return null;
  return {
    [alarmId]: {
      "@type": "Alert",
      action: "display",
      trigger: {
        "@type": "OffsetTrigger",
        offset: offsets[reminder],
        relativeTo: "start",
      },
    },
  };
}
