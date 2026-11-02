import { useCallback, useRef } from "react";
import { useToast } from "../ui/toast.tsx";

type UndoOffer = {
  message: string;
  undo: () => void;
  /** Runs when the offer ends without Undo: expired, dismissed or replaced. */
  onExpire?: () => void;
};

/**
 * Notifications with an Undo button that the Z key also triggers while the
 * offer is shown. A newer notification ends the previous offer.
 */
export function useUndoOffer() {
  const { notify } = useToast();
  const latest = useRef<(() => void) | null>(null);
  const offer = useCallback(
    ({ message, undo, onExpire }: UndoOffer) => {
      let undone = false;
      const run = () => {
        if (undone) return;
        undone = true;
        undo();
      };
      // Undone before the notification goes, so it can never expire instead.
      const byKey = () => {
        latest.current = null;
        run();
        dismiss();
      };
      const dismiss = notify({
        message,
        action: { label: "Undo", onAction: run },
        onClose: () => {
          if (latest.current === byKey) latest.current = null;
          if (!undone) onExpire?.();
        },
      });
      latest.current = byKey;
    },
    [notify],
  );
  const undoLatest = useCallback(() => latest.current?.(), []);
  return { notify, offer, undoLatest };
}
