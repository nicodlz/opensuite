import type { OrganizerAction } from "@opensuite/contracts";
import type { Actor } from "./accounts.ts";
import { fail } from "./jmap-access.ts";
import {
  OrganizerContext,
  organizerStatus,
  type OrganizerDependencies,
  type OrganizerOperation,
} from "./invitations/organizer-context.ts";
import { writeOrganizerCalendar } from "./invitations/organizer-write.ts";
import { sendOrganizerDeliveries } from "./invitations/organizer-send.ts";
import { invitationRunner } from "./invitations/context.ts";
import { prepareOrganizer } from "./invitations/organizer-prepare.ts";
import { getOrganizerStatus } from "./invitations/organizer-status.ts";
import { processOrganizerReply } from "./invitations/organizer-reply.ts";

async function advance(
  ctx: OrganizerContext,
  actor: Actor,
  accountId: string,
  op: OrganizerOperation,
) {
  try {
    await writeOrganizerCalendar(ctx, actor, accountId, op);
    const current = await ctx.organized.operation(actor.id, op.id);
    if (current) await sendOrganizerDeliveries(ctx, actor, accountId, current);
  } catch {
    // After a durable reservation a failed external write may have succeeded.
    // Leave the operation pending until it can be recognized safely.
  }
  const current = await ctx.organized.operation(actor.id, op.id);
  return current ? organizerStatus(current) : fail("unavailable");
}
export function createOrganizerService(dependencies: OrganizerDependencies) {
  const ctx = new OrganizerContext(dependencies);
  const run = invitationRunner(ctx);
  return {
    organize: (actor: Actor, input: OrganizerAction) =>
      run(actor, async () =>
        advance(
          ctx,
          actor,
          input.accountId,
          await prepareOrganizer(ctx, actor, input),
        ),
      ),
    reconcile: (actor: Actor, accountId: string, operationId: string) =>
      run(actor, async () => {
        const c = await ctx.calendar(actor, accountId);
        const op =
          (await ctx.organized.operation(actor.id, operationId)) ??
          fail("not_found");
        if (op.series.accountId !== c.id) return fail("forbidden");
        return advance(ctx, actor, accountId, op);
      }),
    status: (actor: Actor, accountId: string, eventId: string) =>
      run(actor, () => getOrganizerStatus(ctx, actor, accountId, eventId)),
    unverified: (actor: Actor, accountId: string, cursor?: string) =>
      run(actor, async () => {
        const mail = await ctx.mail(actor, accountId);
        const scans = dependencies.scans ?? fail("unavailable");
        const rows = await scans.unverified(actor.id, mail.id, cursor);
        const items = rows.slice(0, 100).map((row) => row.messageId);
        return {
          messageIds: items,
          nextCursor: rows.length > 100 ? (items.at(-1) ?? null) : null,
        };
      }),
    reply: (actor: Actor, accountId: string, messageId: string) =>
      run(actor, () => processOrganizerReply(ctx, actor, accountId, messageId)),
  };
}
export type OrganizerService = ReturnType<typeof createOrganizerService>;
