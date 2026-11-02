import { useEffect, useRef, useState } from "react";

/** Width below which the sidebar becomes a drawer; matches shell.css. */
const narrow = "(max-width: 900px)";

/**
 * Mobile navigation drawer. While it is open, focus moves into it, the rest of
 * the shell is meant to be `inert` and Escape closes it. On close, focus goes
 * back to the button that opened it unless something else took it, such as
 * the composer opened from the drawer.
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
    const query = window.matchMedia(narrow);
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
    element?.querySelector<HTMLElement>("[data-drawer-focus]")?.focus();
    function escape(event: KeyboardEvent) {
      if (event.key === "Escape" && !event.defaultPrevented) setOpen(false);
    }
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("keydown", escape);
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
