import type {
  OrganizedInvitationStore,
  OrganizedReplyScanStore,
} from "@opensuite/db";
import type { OrganizerProtocol } from "../../domain/invitations/organizer.ts";
import type { InvitationDependencies } from "./context.ts";
import { InvitationContext } from "./context.ts";
import type { Actor } from "../accounts.ts";
import { fail, value } from "../jmap-access.ts";

export type OrganizerDependencies = InvitationDependencies & {
  organized: OrganizedInvitationStore;
  scans?: OrganizedReplyScanStore;
  organizerProtocol: OrganizerProtocol;
};
export type OrganizerOperation = NonNullable<
  Awaited<ReturnType<OrganizedInvitationStore["operation"]>>
>;
export class OrganizerContext extends InvitationContext {
  readonly organized: OrganizedInvitationStore;
  readonly organizerProtocol: OrganizerProtocol;
  constructor(dependencies: OrganizerDependencies) {
    super(dependencies);
    this.organized = dependencies.organized;
    this.organizerProtocol = dependencies.organizerProtocol;
  }
  async authorizedSender(actor: Actor, accountId: string, organizer: string) {
    const mail = await this.mail(actor, accountId);
    const alias =
      organizer === mail.address.toLowerCase()
        ? null
        : await this.dependencies.canSendAs?.(actor.id, organizer);
    if (organizer !== mail.address.toLowerCase() && !alias)
      return fail("forbidden");
    const identity = value(
      await mail.client.identities(mail.session, mail.id),
    ).list.find((item) => item.email.toLowerCase() === organizer);
    if (!identity) return fail("forbidden");
    return { mail, identity, alias };
  }
}
export const organizerStatus = (op: OrganizerOperation) => ({
  operationId: op.id,
  state:
    op.phase === "sent"
      ? ("sent" as const)
      : op.phase === "failed"
        ? ("failed" as const)
        : ("pending" as const),
  eventId: op.series.eventId,
});
