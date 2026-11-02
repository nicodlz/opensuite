type CalendarTarget = {
  id: string;
  myRights?: { mayWriteAll?: boolean } | null;
};
export function calendarWriteAccess(
  calendars: readonly CalendarTarget[],
  id: string,
) {
  const calendar = calendars.find((item) => item.id === id);
  if (!calendar) return "not_found" as const;
  return calendar.myRights?.mayWriteAll === false
    ? ("forbidden" as const)
    : ("allowed" as const);
}

type EditableEvent = Record<string, unknown> & {
  recurrenceOverrides?: Record<string, unknown> | null | undefined;
  recurrenceRules?: Record<string, unknown>[] | null | undefined;
  recurrenceRule?: Record<string, unknown> | null | undefined;
  excludedRecurrenceRules?: Record<string, unknown>[] | null | undefined;
  alerts?: Record<string, unknown> | null | undefined;
  locations?: Record<string, Record<string, unknown>> | null | undefined;
};

function unsafeRecurrence(
  event: EditableEvent,
  patch: Record<string, unknown>,
) {
  if (
    "recurrenceOverrides" in patch &&
    event.recurrenceOverrides &&
    Object.keys(event.recurrenceOverrides).length
  )
    return true;
  return (
    ("recurrenceRules" in patch ||
      "excludedRecurrenceRules" in patch ||
      "start" in patch ||
      "timeZone" in patch) &&
    ((
      event.recurrenceRules ??
      (event.recurrenceRule ? [event.recurrenceRule] : [])
    ).some((rule) =>
      Object.keys(rule).some((key) => !["@type", "frequency"].includes(key)),
    ) ||
      (event.excludedRecurrenceRules?.length ?? 0) > 0)
  );
}
function unsafeAlerts(event: EditableEvent, patch: Record<string, unknown>) {
  if (!("alerts" in patch) || !event.alerts) return false;
  const alerts = Object.values(event.alerts);
  return (
    alerts.length !== 1 ||
    alerts.some((alert) => {
      if (!alert || typeof alert !== "object") return true;
      if (!("action" in alert) || alert.action !== "display") return true;
      if (
        Object.keys(alert).some(
          (key) => !["@type", "action", "trigger"].includes(key),
        )
      )
        return true;
      const trigger: unknown = "trigger" in alert ? alert.trigger : undefined;
      return (
        !trigger ||
        typeof trigger !== "object" ||
        !("@type" in trigger) ||
        trigger["@type"] !== "OffsetTrigger" ||
        ("relativeTo" in trigger && trigger.relativeTo !== "start") ||
        Object.keys(trigger).some(
          (key) => !["@type", "offset", "relativeTo"].includes(key),
        )
      );
    })
  );
}
/** Refuse edits that would replace fields the simple editor cannot represent. */
export function unsafeSimpleEdit(
  event: EditableEvent,
  patch: Record<string, unknown>,
) {
  if (unsafeRecurrence(event, patch) || unsafeAlerts(event, patch)) return true;
  if (
    "locations" in patch &&
    event.locations &&
    (Object.keys(event.locations).length > 1 ||
      Object.values(event.locations).some((location) =>
        Object.keys(location).some((key) => !["@type", "name"].includes(key)),
      ))
  )
    return true;
  return Boolean(
    "description" in patch &&
    event["descriptionContentType"] &&
    event["descriptionContentType"] !== "text/plain",
  );
}
