import type { ParsedInvitationReply } from "../../domain/invitations/types.ts";
import type { Actor } from "../accounts.ts";
import { fail, value } from "../jmap-access.ts";
import type { OrganizerContext } from "./organizer-context.ts";
import { protocolValue } from "./state.ts";
import { rebaseOrganizerSeries } from "./organizer-rebase.ts";
import { verifiedSender } from "./verification.ts";

type Series = NonNullable<
  Awaited<ReturnType<OrganizerContext["organized"]["byUid"]>>
>;
function matches(
  ctx: OrganizerContext,
  series: Series,
  reply: ParsedInvitationReply,
  attendee: string,
) {
  if (
    !series.calendar ||
    !series.eventId ||
    series.cancelled ||
    series.pendingId ||
    series.organizer !== reply.event.organizer.email ||
    !reply.recipients.includes(series.organizer)
  )
    return false;
  const participants = protocolValue(
    ctx.organizerProtocol.attendees(series.calendar),
  );
  return (
    participants.some((person) => person.email === attendee) &&
    protocolValue(
      ctx.organizerProtocol.hasOccurrence(series.calendar, reply.occurrence),
    )
  );
}
async function apply(
  ctx: OrganizerContext,
  actor: Actor,
  accountId: string,
  reply: ParsedInvitationReply,
  attendee: string,
) {
  const c = await ctx.calendar(actor, accountId);
  const prior = await ctx.organized.byUid(actor.id, c.id, reply.event.uid);
  if (!prior) return "conflict" as const;
  if (
    prior.organizer !== reply.event.organizer.email ||
    !reply.recipients.includes(prior.organizer)
  )
    return "conflict" as const;
  if (prior.pendingId) return "pending" as const;
  const raw = await ctx.rawCalendar(actor, accountId, prior.uid);
  if (!raw) return "conflict" as const;
  const series = await rebaseOrganizerSeries(ctx, actor, prior, c, raw, false);
  if (!series || !matches(ctx, series, reply, attendee))
    return "conflict" as const;
  if (reply.event.sequence !== series.sequence)
    return reply.event.sequence < series.sequence
      ? ("stale" as const)
      : ("conflict" as const);
  const result = await ctx.organized.response({
    seriesId: series.id,
    userId: actor.id,
    revision: series.revision,
    sequence: series.sequence,
    attendee,
    occurrence: reply.occurrence,
    timestamp: reply.timestamp,
    partstat: reply.event.attendees[0]?.partstat ?? fail("validation"),
  });
  return result === "retry" ? ("pending" as const) : result;
}
export async function processOrganizerReply(
  ctx: OrganizerContext,
  actor: Actor,
  accountId: string,
  messageId: string,
) {
  const mail = await ctx.mail(actor, accountId);
  const email =
    value(
      await mail.client.emails(mail.session, mail.id, [messageId]),
    ).list.find((item) => item.id === messageId) ?? fail("not_found");
  const raw = value(
    await mail.client.download(mail.session, mail.id, email.blobId),
  );
  const reply = protocolValue(await ctx.organizerProtocol.parseReply(raw));
  const attendee = reply.event.attendees[0]?.email ?? fail("validation");
  let verified = false;
  let verificationPending = false;
  try {
    verified = await verifiedSender(
      ctx,
      mail,
      messageId,
      attendee,
      reply.from,
      reply.signingDomains,
    );
  } catch {
    verificationPending = true;
  }
  const detail = {
    event: reply.event,
    from: reply.from,
    occurrence: reply.occurrence,
    verificationPending,
  };
  if (!verified)
    return {
      ...detail,
      senderStatus: "unverified" as const,
      result: "unverified" as const,
    };
  return {
    ...detail,
    senderStatus: "verified" as const,
    result: await apply(ctx, actor, accountId, reply, attendee),
  };
}
