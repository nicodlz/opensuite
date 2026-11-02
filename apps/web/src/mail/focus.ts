import { useCallback, useEffect, useRef } from "react";

type Target = () => HTMLElement | null;

export const isShown = (element: Element) =>
  element.isConnected && element.checkVisibility();

/** Focus is nowhere useful: the page, the main region or a vanished element. */
const isLost = (active: Element | null) =>
  !active ||
  active === document.body ||
  active.tagName === "MAIN" ||
  !isShown(active);

/**
 * Sends keyboard focus where an action leads, such as the next conversation
 * after an archive, so it never falls back to the page when the control that
 * had it disappears.
 *
 * `focusAfter(target)` focuses `target()` as soon as it is shown, whenever
 * focus is lost. With `follow`, it also moves focus once from an element
 * matching `cursor`, such as a list row, so focus follows the keyboard
 * selection. The request ends at the next key or pointer press, so later
 * updates never take focus from where the user moved it.
 */
export function useFocusAfter(cursor: string) {
  const request = useRef<{ target: Target; follow: boolean } | null>(null);
  const apply = useCallback(() => {
    const current = request.current;
    const target = current?.target();
    const active = document.activeElement;
    if (!current || !target || target === active || !isShown(target)) return;
    if (isLost(active)) target.focus();
    else if (current.follow && active?.matches(cursor)) {
      current.follow = false;
      target.focus();
    }
  }, [cursor]);
  useEffect(() => {
    const end = () => {
      request.current = null;
    };
    const check = () => queueMicrotask(apply);
    // Removing or hiding the focused element fires no focus event.
    const observer = new MutationObserver(apply);
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["class", "hidden"],
    });
    document.addEventListener("keydown", end, true);
    document.addEventListener("pointerdown", end, true);
    document.addEventListener("focusin", check);
    document.addEventListener("focusout", check);
    return () => {
      observer.disconnect();
      document.removeEventListener("keydown", end, true);
      document.removeEventListener("pointerdown", end, true);
      document.removeEventListener("focusin", check);
      document.removeEventListener("focusout", check);
    };
  }, [apply]);
  return useCallback(
    (target: Target, { follow = false }: { follow?: boolean } = {}) => {
      request.current = { target, follow };
      queueMicrotask(apply);
    },
    [apply],
  );
}

const firstShown = (...elements: (HTMLElement | null | undefined)[]) =>
  elements.find((element) => element && isShown(element)) ?? null;
const readingSubject = () =>
  document.querySelector<HTMLElement>(".reading-subject h2");
/** A conversation's row, or its subject when the reader covers the list. */
export const conversationFocus = (list: HTMLElement | null, id: string) =>
  firstShown(
    list?.querySelector<HTMLElement>(`[data-thread-id="${CSS.escape(id)}"]`),
    readingSubject(),
  );
/**
 * Where focus rests when the control that had it goes away: the selected
 * conversation, else the open conversation's subject, else the list heading.
 */
export const restingFocus = (list: HTMLElement | null) =>
  firstShown(
    list?.querySelector<HTMLElement>("[data-thread-id][aria-current]"),
    readingSubject(),
    list?.querySelector<HTMLElement>(".list-title h1"),
    list?.querySelector<HTMLElement>(".list-check"),
  );
