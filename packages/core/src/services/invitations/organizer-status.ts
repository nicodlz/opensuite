import type { Actor } from "../accounts.ts";
import { seriesIdOf } from "../calendar-time.ts";
import { fail } from "../jmap-access.ts";
import type { OrganizerContext } from "./organizer-context.ts";
import { protocolValue } from "./state.ts";
import { rebaseOrganizerSeries } from "./organizer-rebase.ts";

export async function getOrganizerStatus(
  ctx: OrganizerContext,
  actor: Actor,
  accountId: string,
  eventId: string,
) {
  const c = await ctx.calendar(actor, accountId);
  const stored = await ctx.organized.series(
    actor.id,
    c.id,
    seriesIdOf(eventId),
  );
  if (!stored?.calendar || !stored.eventId) return fail("not_found");
  const raw = stored.pendingId
    ? null
    : await ctx.rawCalendar(actor, accountId, stored.uid);
  if (!raw && !stored.pendingId) return fail("conflict");
  const series = stored.pendingId
    ? stored
    : await rebaseOrganizerSeries(ctx, actor, stored, c, raw ?? "", false);
  if (!series?.calendar) return fail("conflict");
  const attendees = protocolValue(
    ctx.organizerProtocol.attendees(series.calendar),
  );
  const statuses = attendees.flatMap((attendee) => {
    const replies = series.responses.filter(
      (reply) =>
        reply.attendee === attendee.email && reply.sequence === series.sequence,
    );
    return replies.length
      ? replies.map((reply) => ({
          email: attendee.email,
          partstat: reply.partstat,
          occurrence: reply.occurrence,
        }))
      : [
          {
            email: attendee.email,
            partstat: attendee.partstat,
            occurrence: "master",
          },
        ];
  });
  return {
    organizer: series.organizer,
    sequence: series.sequence,
    cancelled: series.cancelled,
    pendingOperationId: series.pendingId,
    attendees: statuses,
  };
}
