import { useCallback, useEffect, useRef } from "react";

type Target = () => HTMLElement | null;

// Long enough for a save and the listing that follows it.
const patience = 5000;

const reachable = (element: Element) =>
  element.isConnected &&
  element.checkVisibility() &&
  !element.matches(":disabled") &&
  !element.closest("[inert], [aria-hidden='true']");

/**
 * Focus nobody chose: the page, the main region, a dialog that took it back
 * from a removed element, or an element that went away or was disabled.
 */
const adrift = (active: Element | null) =>
  !active ||
  active === document.body ||
  active.tagName === "MAIN" ||
  active.getAttribute("role") === "dialog" ||
  !reachable(active);

/**
 * Puts keyboard focus where an action leads, such as the item after the ones
 * moved to the trash or a folder just created. Drive dialogs have no trigger
 * to return to and toolbar buttons leave with the selection, so focus would
 * otherwise fall back to the page.
 *
 * `focusAfter(target)` focuses `target()` once it is on the page, while focus
 * is adrift. A request ends when it is applied, at the next key or pointer
 * press, or after a few seconds, so it never takes focus from where the user
 * moved it.
 */
export function useFocusAfter() {
  const request = useRef<{ target: Target; until: number } | null>(null);
  const apply = useCallback(() => {
    const current = request.current;
    if (!current) return;
    if (Date.now() > current.until) {
      request.current = null;
      return;
    }
    const target = current.target();
    if (!target || !reachable(target) || !adrift(document.activeElement))
      return;
    request.current = null;
    target.focus();
  }, []);
  useEffect(() => {
    // A key or pointer press means the user chooses where focus goes.
    const listeners: [string, () => void, boolean][] = [
      ["keydown", () => (request.current = null), true],
      ["pointerdown", () => (request.current = null), true],
      ["focusout", () => queueMicrotask(apply), false],
    ];
    for (const [type, listener, capture] of listeners)
      document.addEventListener(type, listener, capture);
    // Removing, hiding or disabling the focused element fires no focus event.
    const observer = new MutationObserver(apply);
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributeFilter: ["class", "hidden", "inert", "aria-hidden", "disabled"],
    });
    return () => {
      observer.disconnect();
      for (const [type, listener, capture] of listeners)
        document.removeEventListener(type, listener, capture);
    };
  }, [apply]);
  return useCallback(
    (target: Target) => {
      request.current = { target, until: Date.now() + patience };
      queueMicrotask(apply);
    },
    [apply],
  );
}

/** The entry after `ids` in `order`, else the one before them. */
export function neighbour(order: readonly string[], ids: readonly string[]) {
  const leaving = new Set(ids);
  const first = order.findIndex((id) => leaving.has(id));
  if (first < 0) return null;
  return (
    order.slice(first).find((id) => !leaving.has(id)) ??
    order.slice(0, first).findLast((id) => !leaving.has(id)) ??
    null
  );
}

/** The first of `elements` that can take focus now. */
export const firstReachable = (...elements: (HTMLElement | null)[]) =>
  elements.find((element) => element !== null && reachable(element)) ?? null;
