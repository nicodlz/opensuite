import type { OrganizerService } from "../invitations-outbound.ts";
import type {
  OrganizedInvitationStore,
  OrganizedReplyScanStore,
} from "@opensuite/db";

/** Resume old reservations through the same generation-fenced service path. */
export async function reconcileOrganizerPending(
  store: OrganizedInvitationStore,
  service: OrganizerService,
) {
  const candidates = await store.pending();
  const reconcileAt = async (index: number): Promise<void> => {
    const item = candidates[index];
    if (!item) return;
    if (
      await store.claimRecovery(item.userId, item.operationId, item.updatedAt)
    )
      await service.reconcile(
        { id: item.userId, email: item.address, role: "user" },
        item.accountId,
        item.operationId,
      );
    await reconcileAt(index + 1);
  };
  await reconcileAt(0);
}

/** Scan imported messages with the same account-scoped verifier used by HTTP. */
export async function scanOrganizerReplies(
  scans: OrganizedReplyScanStore,
  service: OrganizerService,
  audit?: (event: { userId: string | null; action: string }) => Promise<void>,
  now: () => number = Date.now,
) {
  const candidates = await scans.candidates();
  const processAt = async (index: number): Promise<void> => {
    const item = candidates[index];
    if (!item) return;
    const result = await service.reply(
      { id: item.userId, email: item.address, role: "user" },
      item.accountId,
      item.messageId,
    );
    const outcome = result.isOk()
      ? result.value.result
      : result.error.kind === "validation"
        ? "not_reply"
        : "retry";
    if (result.isOk())
      await audit?.({
        userId: item.userId,
        action: `invitation.reply.${outcome}`,
      });
    const finished =
      outcome !== "retry" &&
      !(result.isOk() && result.value.verificationPending);
    const nextAttemptAt = finished ? null : new Date(now() + 3_600_000);
    await scans.record({
      userId: item.userId,
      accountId: item.accountId,
      messageId: item.messageId,
      outcome,
      uid: result.isOk() ? result.value.event.uid : null,
      finished,
      nextAttemptAt,
    });
    await processAt(index + 1);
  };
  await processAt(0);
}
