import type { AddressLimit } from "@opensuite/core/services/addresses";

/**
 * The plan's address allowance, capped by the operator's anti-abuse limit.
 * Self-hosted, operator and unlimited accounts have no plan limit (null).
 */
export const entitledAddressLimit =
  (
    entitlements: {
      get(userId: string): Promise<{ readonly addressLimit: number | null }>;
    },
    cap: number,
  ): AddressLimit =>
  async (actor) => {
    const { addressLimit } = await entitlements.get(actor.id);
    return addressLimit === null ? cap : Math.min(addressLimit, cap);
  };
