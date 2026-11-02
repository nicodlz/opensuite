import type { Prisma } from "./generated/index.js";

export const unresolvedHandoff = {
  kind: "conflict" as const,
  message:
    "An earlier scheduled send has an unresolved outcome; try again after it is reconciled.",
};

/** A handoff without a proven outcome must not be overtaken by revocation. */
export async function hasUnresolvedHandoff(
  tx: Prisma.TransactionClient,
  userId: string,
  address: string,
) {
  return (
    (await tx.scheduledSend.count({
      where: {
        userId,
        senderAddress: address.toLowerCase(),
        state: { in: ["creating", "unknown", "canceling"] },
      },
    })) > 0
  );
}
