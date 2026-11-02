import type { AliasService } from "./aliases.ts";
import type { AddressService } from "./addresses.ts";
import { createMailService } from "./mail.ts";
import type { Actor } from "./accounts.ts";
import {
  InvitationContext,
  invitationRunner,
  type InvitationDependencies,
} from "./invitations/context.ts";
import { act } from "./invitations/action.ts";
import { reconcile } from "./invitations/reconcile.ts";
import { readableVerification } from "./invitations/verification.ts";
import type { InvitationAction } from "./invitations/state.ts";

export function createInvitationService(dependencies: InvitationDependencies) {
  const ctx = new InvitationContext(dependencies);
  const run = invitationRunner(ctx);
  return {
    read: (actor: Actor, accountId: string, messageId: string) =>
      run(actor, async () => {
        const mail = await ctx.mail(actor, accountId);
        const invitation = await ctx.read(mail, messageId);
        const verified = await readableVerification(
          ctx,
          actor,
          accountId,
          mail,
          messageId,
          invitation,
        );
        return {
          method: invitation.method,
          events: invitation.events,
          senderStatus: verified
            ? ("verified" as const)
            : ("unverified" as const),
        };
      }),
    act: (actor: Actor, input: InvitationAction) =>
      run(actor, () => act(ctx, actor, input)),
    confirm: (actor: Actor, input: InvitationAction) =>
      run(actor, () => act(ctx, actor, input, true)),
    reconcile: (actor: Actor, accountId: string, operationId: string) =>
      run(actor, () => reconcile(ctx, actor, accountId, operationId)),
  };
}
/** Configure mail and invitations with the same authorized sending identities. */
export function createMailWithInvitations(
  dependencies: InvitationDependencies & {
    aliases: Pick<AliasService, "canSendAs">;
    addresses: Pick<AddressService, "canSendAs">;
  },
) {
  const canSendAs = async (userId: string, address: string) => {
    const result = await dependencies.aliases.canSendAs(userId, address);
    if (result.isOk() && result.value) return `alias:${result.value}`;
    const found = await dependencies.addresses.canSendAs(userId, address);
    return found.isOk() && found.value ? `address:${found.value}` : null;
  };
  const shared = { ...dependencies, canSendAs };
  return {
    canSendAs,
    mail: createMailService(shared),
    invitations: createInvitationService(shared),
  };
}
export type InvitationService = ReturnType<typeof createInvitationService>;
