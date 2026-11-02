import type { Actor } from "../accounts.ts";
import type { Connection } from "./context.ts";
import type { OrganizerContext } from "./organizer-context.ts";
import { digest } from "./state.ts";

type Series = NonNullable<
  Awaited<ReturnType<OrganizerContext["organized"]["byUid"]>>
>;
/** Adopt safe owner-side calendar edits without treating attendee changes as replies. */
export async function rebaseOrganizerSeries(
  ctx: OrganizerContext,
  actor: Actor,
  series: Series,
  c: Connection,
  raw: string,
  allowScheduleChanges: boolean,
) {
  if (!series.eventId || c.id !== series.accountId) return null;
  const current = await ctx.getEvent(c, series.eventId);
  if (
    current.event.uid !== series.uid ||
    !current.event.calendarIds[series.calendarId]
  )
    return null;
  const snapshot = digest(raw);
  if (snapshot === series.snapshot) return series;
  if (!series.calendar || series.pendingId || series.cancelled) return null;
  const sequence = ctx.organizerProtocol.rebase(
    series.calendar,
    raw,
    series.uid,
    series.organizer,
    allowScheduleChanges,
  );
  if (sequence.isErr() || sequence.value < series.sequence) return null;
  const updated = await ctx.organized.rebase(
    actor.id,
    series.id,
    series.revision,
    raw,
    snapshot,
    sequence.value,
  );
  if (!updated) return null;
  return ctx.organized.byUid(actor.id, series.accountId, series.uid);
}
