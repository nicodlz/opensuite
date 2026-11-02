import {
  NotificationSchema,
  quarantineReason,
} from "../../domain/notification.ts";
import { alignedSigningDomains } from "../../domain/invitations/alignment.ts";
import type {
  ParsedInvitation,
  Participation,
} from "../../domain/invitations/types.ts";
import type { Connection, InvitationContext } from "./context.ts";
import type { Actor } from "../accounts.ts";

/** Trust only verdicts attached to this immutable imported message and mailbox. */
export async function verifiedOrganizer(
  ctx: InvitationContext,
  mail: Connection,
  messageId: string,
  invitation: ParsedInvitation,
  previousOrganizer?: string,
): Promise<boolean> {
  const organizer = invitation.events[0]?.organizer.email;
  if (
    !organizer ||
    invitation.from.length !== 1 ||
    invitation.from[0] !== organizer ||
    !alignedSigningDomains(organizer, invitation.signingDomains) ||
    (previousOrganizer !== undefined && previousOrganizer !== organizer)
  )
    return false;
  if (!ctx.dependencies.intentions) return false;
  const receipts = await ctx.dependencies.intentions.authentication(
    mail.id,
    messageId,
  );
  if (receipts.length > 50) return false;
  return receipts.some(({ message }) => {
    const parsed = NotificationSchema.safeParse(message.notification);
    if (!parsed.success || quarantineReason(parsed.data) !== null) return false;
    const receipt = parsed.data.receipt;
    return (
      receipt.dmarcVerdict.status === "PASS" ||
      receipt.dkimVerdict.status === "PASS"
    );
  });
}

/** An explicit confirmation can only create an unverified new REQUEST. */
export function canConfirmUnverified(
  confirmed: boolean,
  invitation: ParsedInvitation,
  choice: Participation | undefined,
  prior: {
    eventId: string | null;
    calendar: string | null;
    pendingId: string | null;
  } | null,
): boolean {
  return (
    confirmed &&
    invitation.method === "REQUEST" &&
    choice !== undefined &&
    !prior?.eventId &&
    !prior?.calendar &&
    !prior?.pendingId
  );
}

/** Reading a message stays available when provenance or Calendar cannot be checked. */
export async function readableVerification(
  ctx: InvitationContext,
  actor: Actor,
  accountId: string,
  mail: Connection,
  messageId: string,
  invitation: ParsedInvitation,
): Promise<boolean> {
  try {
    if (!(await verifiedOrganizer(ctx, mail, messageId, invitation)))
      return false;
    const uid = invitation.events[0]?.uid;
    if (!uid || !ctx.dependencies.intentions) return false;
    const calendar = await ctx.calendar(actor, accountId);
    const prior = await ctx.dependencies.intentions.series({
      userId: actor.id,
      accountId: calendar.id,
      uid,
    });
    return !prior || prior.organizer === invitation.events[0]?.organizer.email;
  } catch {
    return false;
  }
}
