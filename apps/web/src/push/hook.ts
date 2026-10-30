import { useCallback } from "react";
import type { PushProduct } from "@opensuite/contracts";

export const notificationOfferEvent = "esuno-notification-offer";
export const notificationEnabledEvent = "esuno-notification-enabled";
export const notificationEnabledStorageKey = "esuno-notification-enabled";
export interface NotificationOffer {
  reason: string;
  message: string;
}
/** Features offer context; this does not request browser permission. */
export function useNotificationPrompt(product: PushProduct) {
  const offer = useCallback(
    (details: NotificationOffer) => {
      window.dispatchEvent(
        new CustomEvent(notificationOfferEvent, {
          detail: { product, ...details },
        }),
      );
    },
    [product],
  );
  return { offer };
}
