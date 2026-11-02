import * as React from "react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { Button } from "./button.tsx";
import { Icon } from "./icons.tsx";

/**
 * Notifications for the whole app: one at a time, always at the same place.
 *
 * - Mount `<ToastProvider>` once near the root. A nested provider reuses the
 *   outer one, so there is still a single region.
 * - Show a message with `useToast().notify({ message, action, onClose })`. It
 *   returns a function that removes the notification without calling
 *   `onClose`.
 * - `<Toast open message onOpenChange />` is the controlled form for simple
 *   status messages.
 *
 * The live text node stays mounted for the whole session: screen readers
 * announce changes to an existing region reliably, and modal dialogs leave
 * `aria-live` elements exposed. A notification stays 6 s (10 s with an
 * action) and the countdown pauses while the pointer is over it or focus is
 * in it. F8 moves focus to it; Escape dismisses it and focus goes back to
 * where it was.
 */
export type ToastOptions = {
  message: string;
  /** One button, such as Undo. Choosing it also closes the notification. */
  action?: { label: string; onAction: () => void };
  /** Milliseconds before the notification expires. */
  duration?: number;
  /** Runs once when it expires, is dismissed, is acted on or is replaced. */
  onClose?: () => void;
};
type Notice = ToastOptions & { id: number };
type PauseReason = "pointer" | "focus";

/** Current notification and its pausable countdown, independent of React. */
export class ToastStore {
  #notice: Notice | null = null;
  #counter = 0;
  #listeners = new Set<() => void>();
  #timer: ReturnType<typeof setTimeout> | undefined;
  #remaining = 0;
  #since = 0;
  #paused = new Set<PauseReason>();

  snapshot = (): Notice | null => this.#notice;
  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };
  notify = (options: ToastOptions): (() => void) => {
    const previous = this.#notice;
    this.#counter += 1;
    const notice: Notice = { ...options, id: this.#counter };
    this.#halt();
    this.#notice = notice;
    this.#remaining = options.duration ?? (options.action ? 10_000 : 6000);
    this.#run();
    this.#emit();
    previous?.onClose?.();
    return () => this.close(notice.id, false);
  };
  /** Removes notification `id` if it is still shown; `notifyOwner` runs its `onClose`. */
  close = (id: number, notifyOwner: boolean) => {
    const notice = this.#notice;
    if (notice?.id !== id) return;
    this.#halt();
    this.#notice = null;
    // The pointer or focus was on the element that is going away.
    this.#paused.clear();
    this.#emit();
    if (notifyOwner) notice.onClose?.();
  };
  pause = (reason: PauseReason) => {
    this.#paused.add(reason);
    if (this.#timer === undefined) return;
    this.#halt();
    this.#remaining -= Date.now() - this.#since;
  };
  resume = (reason: PauseReason) => {
    this.#paused.delete(reason);
    this.#run();
  };

  #run() {
    const notice = this.#notice;
    if (!notice || this.#paused.size > 0 || this.#timer !== undefined) return;
    this.#since = Date.now();
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.close(notice.id, true);
    }, this.#remaining);
  }
  #halt() {
    clearTimeout(this.#timer);
    this.#timer = undefined;
  }
  #emit() {
    for (const listener of this.#listeners) listener();
  }
}

type ToastApi = Pick<ToastStore, "notify">;
const ToastContext = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  if (!api) throw new Error("useToast needs a ToastProvider");
  return api;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const outer = useContext(ToastContext);
  if (outer) return <>{children}</>;
  return <ToastRegion>{children}</ToastRegion>;
}

/** Shows `message` while `open`; reports expiry or dismissal through `onOpenChange`. */
export function Toast({
  open,
  onOpenChange,
  message,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  message: string;
}) {
  const { notify } = useToast();
  const report = useRef(onOpenChange);
  useEffect(() => {
    report.current = onOpenChange;
  });
  useEffect(() => {
    if (!open) return undefined;
    return notify({ message, onClose: () => report.current(false) });
  }, [open, message, notify]);
  return null;
}

/**
 * Keyboard, pointer and focus handling of the region. `finish` closes a
 * notification and first moves focus back out of it, so keyboard users are
 * not left on a button that is about to disappear.
 */
function useRegionBehaviour(store: ToastStore) {
  const regionRef = useRef<HTMLElement>(null);
  const returnTo = useRef<HTMLElement | null>(null);
  const finish = useCallback(
    (id: number) => {
      const node = regionRef.current;
      if (node?.contains(document.activeElement)) {
        const target = returnTo.current;
        if (target?.isConnected && !target.closest("[inert]")) target.focus();
        // A target that refuses focus, such as a disabled button.
        if (node.contains(document.activeElement))
          document.querySelector<HTMLElement>("main")?.focus();
      }
      store.close(id, true);
    },
    [store],
  );
  useEffect(() => {
    function handleKey(event: KeyboardEvent) {
      const active = store.snapshot();
      const node = regionRef.current;
      if (!active || !node || event.defaultPrevented) return;
      const plain =
        !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey;
      if (event.key === "F8" && plain) {
        event.preventDefault();
        node.querySelector("button")?.focus();
      } else if (
        event.key === "Escape" &&
        node.contains(document.activeElement)
      ) {
        event.preventDefault();
        finish(active.id);
      }
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [store, finish]);
  useEffect(() => {
    // Hover and focus hold the countdown; focus remembers where it came from.
    const node = regionRef.current;
    if (!node) return undefined;
    const hover = () => store.pause("pointer");
    const leave = () => store.resume("pointer");
    function focusIn(event: FocusEvent) {
      const from = event.relatedTarget;
      if (!(from instanceof Node && node?.contains(from)))
        returnTo.current = from instanceof HTMLElement ? from : null;
      store.pause("focus");
    }
    function focusOut(event: FocusEvent) {
      const to = event.relatedTarget;
      if (to instanceof Node && node?.contains(to)) return;
      if (to) returnTo.current = null;
      store.resume("focus");
    }
    node.addEventListener("pointerenter", hover);
    node.addEventListener("pointerleave", leave);
    node.addEventListener("focusin", focusIn);
    node.addEventListener("focusout", focusOut);
    return () => {
      node.removeEventListener("pointerenter", hover);
      node.removeEventListener("pointerleave", leave);
      node.removeEventListener("focusin", focusIn);
      node.removeEventListener("focusout", focusOut);
    };
  }, [store]);
  return { regionRef, finish };
}

/** The visible card; its live text node exists even with nothing to show. */
function ToastCard({
  notice,
  finish,
}: {
  notice: Notice | null;
  finish: (id: number) => void;
}) {
  return (
    <div className="toast" data-state={notice ? "open" : "closed"}>
      <div className="toast-message" aria-live="polite" aria-atomic="true">
        {notice && <span key={notice.id}>{notice.message}</span>}
      </div>
      {notice?.action && (
        <Button
          variant="ghost"
          size="small"
          className="toast-action"
          onClick={() => {
            notice.action?.onAction();
            finish(notice.id);
          }}
        >
          {notice.action.label}
        </Button>
      )}
      {notice && (
        <Button
          variant="ghost"
          size="small"
          className="toast-close"
          aria-label="Dismiss notification"
          onClick={() => finish(notice.id)}
        >
          <Icon name="close" size={16} />
        </Button>
      )}
    </div>
  );
}

function ToastRegion({ children }: { children: ReactNode }) {
  const [store] = useState(() => new ToastStore());
  const notice = useSyncExternalStore(store.subscribe, store.snapshot);
  const { regionRef, finish } = useRegionBehaviour(store);
  const api = useMemo(() => ({ notify: store.notify }), [store]);
  return (
    <ToastContext value={api}>
      {children}
      <section
        ref={regionRef}
        className="toast-viewport"
        aria-label="Notifications (F8)"
      >
        <ToastCard notice={notice} finish={finish} />
      </section>
    </ToastContext>
  );
}
