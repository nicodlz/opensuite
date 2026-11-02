import { useEffect, useRef, useState } from "react";
import { drawerQuery } from "./media.ts";

const tabbable =
  "a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]";

/** Tab past the last control goes to the first; Shift+Tab, the other way. */
function wrap(container: HTMLElement, event: KeyboardEvent) {
  const stops = [...container.querySelectorAll<HTMLElement>(tabbable)].filter(
    (element) => element.tabIndex >= 0 && element.checkVisibility(),
  );
  const first = stops[0];
  const last = stops.at(-1);
  if (!first || !last) return;
  const active = document.activeElement;
  const outside = !container.contains(active);
  if (event.shiftKey && (active === first || outside)) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (active === last || outside)) {
    event.preventDefault();
    first.focus();
  }
}

/**
 * Mobile navigation drawer. While it is open, focus moves into it and stays
 * there: Tab and Shift+Tab wrap at its edges, the rest of the shell is meant
 * to be `inert`, and focus reaching anything else, such as a notification, is
 * sent back. Escape closes it. On close, focus goes back to the button that
 * opened it unless something else took it, such as the composer opened from
 * the drawer.
 */
export function useNavigationDrawer() {
  const [open, setOpen] = useState(false);
  const drawer = useRef<HTMLElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    // Following a link or a folder in the drawer closes it.
    const element = drawer.current;
    function close(event: MouseEvent) {
      if (
        event.target instanceof Element &&
        event.target.closest("a, button[data-nav]")
      )
        setOpen(false);
    }
    element?.addEventListener("click", close);
    return () => element?.removeEventListener("click", close);
  }, []);
  useEffect(() => {
    // The drawer only exists on narrow screens; widening the window closes it.
    const query = window.matchMedia(drawerQuery);
    function change() {
      if (!query.matches) setOpen(false);
    }
    query.addEventListener("change", change);
    return () => query.removeEventListener("change", change);
  }, []);
  useEffect(() => {
    if (!open) return undefined;
    const element = drawer.current;
    const button = opener.current;
    const start = () =>
      element?.querySelector<HTMLElement>("[data-drawer-focus]")?.focus();
    start();
    function keys(event: KeyboardEvent) {
      if (event.defaultPrevented) return;
      if (event.key === "Escape") setOpen(false);
      else if (event.key === "Tab" && element) wrap(element, event);
    }
    function contain(event: FocusEvent) {
      const target = event.target;
      if (!(target instanceof Element) || element?.contains(target)) return;
      // A dialog or menu opened over the drawer, for example by a keyboard
      // shortcut, takes over; anything else (such as a notification) does not.
      if (
        target.closest("[role='dialog'], [role='alertdialog'], [role='menu']")
      )
        setOpen(false);
      else start();
    }
    document.addEventListener("keydown", keys);
    document.addEventListener("focusin", contain);
    return () => {
      document.removeEventListener("keydown", keys);
      document.removeEventListener("focusin", contain);
      const active = document.activeElement;
      if (
        active === null ||
        active === document.body ||
        element?.contains(active)
      )
        button?.focus();
    };
  }, [open]);
  return { open, setOpen, drawerRef: drawer, openerRef: opener };
}
