import type { AddressLimit } from "@opensuite/core/services/addresses";

/** Cloud entitlements should replace this single injected policy when available. */
export const operatorAddressLimit =
  (cap: number): AddressLimit =>
  () =>
    Promise.resolve(cap);
