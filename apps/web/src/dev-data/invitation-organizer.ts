import { invitationsContract } from "@opensuite/contracts";
import { implement } from "@orpc/server";

const api = implement(invitationsContract);

const unavailable = ({
  errors,
}: {
  errors: { UPSTREAM_UNAVAILABLE: () => Error };
}): never => {
  throw errors.UPSTREAM_UNAVAILABLE();
};

/** Organizer flows have no synthetic fixtures yet: none waits, the rest is unavailable. */
export const organizerHandlers = {
  organize: api.organize.handler(unavailable),
  organizedStatus: api.organizedStatus.handler(unavailable),
  unverifiedReplies: api.unverifiedReplies.handler(() => ({
    messageIds: [],
    nextCursor: null,
  })),
  processReply: api.processReply.handler(unavailable),
  reconcileOrganized: api.reconcileOrganized.handler(unavailable),
};
