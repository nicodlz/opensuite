import { err, ok } from "neverthrow";
import type { OrganizedInvitationStore } from "@opensuite/db";
import type { CalendarService } from "../calendar.ts";
import { createJmapAccess, fail, value } from "../jmap-access.ts";
import type { MailCredentialStore } from "../jmap-access.ts";
import type { Actor } from "../accounts.ts";
import { seriesIdOf } from "../calendar-time.ts";

function deleteCancelled(
  access: ReturnType<typeof createJmapAccess>,
  actor: Actor,
  accountId: string,
  eventId: string,
  series: NonNullable<Awaited<ReturnType<OrganizedInvitationStore["series"]>>>,
) {
  return access.run(async () => {
    if (series.eventId !== eventId) return fail("conflict");
    const c = await access.connect(
      actor,
      accountId,
      "urn:ietf:params:jmap:calendars",
    );
    if (c.id !== series.accountId) return fail("forbidden");
    const selected = value(await c.client.calendars(c.session, c.id)).list.find(
      (item) => item.id === series.calendarId,
    );
    if (!selected || selected.myRights?.mayWriteAll !== true)
      return fail("forbidden");
    const current = value(
      await c.client.calendarEvents(c.session, c.id, [eventId]),
    );
    const event = current.list.find((item) => item.id === eventId);
    if (!event) return fail("not_found");
    if (
      event.uid !== series.uid ||
      !event.calendarIds[series.calendarId] ||
      event["status"] !== "cancelled"
    )
      return fail("conflict");
    value(
      await c.client.destroyCalendarEvent(
        c.session,
        c.id,
        eventId,
        current.state,
      ),
    );
    return { success: true as const };
  });
}

/** Route edits of organized events through the invitation workflow. */
export function guardOrganizedCalendar(
  calendar: CalendarService,
  credentials: MailCredentialStore,
  organized: OrganizedInvitationStore,
  origin: string,
): CalendarService {
  const access = createJmapAccess({ store: credentials, origin });
  const lookup = async (actor: Actor, accountId: string, eventId: string) => {
    try {
      const credential = await credentials.getForOwner(actor.id, accountId);
      if (credential.isErr())
        return err({
          kind:
            credential.error.kind === "forbidden" ||
            credential.error.kind === "not_found"
              ? ("forbidden" as const)
              : ("unavailable" as const),
        });
      if (accountId !== "default" && credential.value.accountId !== accountId)
        return err({ kind: "forbidden" as const });
      return ok(
        await organized.series(
          actor.id,
          credential.value.accountId,
          seriesIdOf(eventId),
        ),
      );
    } catch {
      return err({ kind: "unavailable" as const });
    }
  };
  return {
    ...calendar,
    updateEvent: async (actor, accountId, eventId, event) => {
      const series = await lookup(actor, accountId, eventId);
      if (series.isErr()) return err(series.error);
      return series.value
        ? err({ kind: "conflict" as const })
        : calendar.updateEvent(actor, accountId, eventId, event);
    },
    deleteEvent: async (actor, accountId, eventId) => {
      const series = await lookup(actor, accountId, eventId);
      if (series.isErr()) return err(series.error);
      if (!series.value) return calendar.deleteEvent(actor, accountId, eventId);
      if (!series.value.cancelled || series.value.pendingId)
        return err({ kind: "conflict" as const });
      return deleteCancelled(access, actor, accountId, eventId, series.value);
    },
  };
}
