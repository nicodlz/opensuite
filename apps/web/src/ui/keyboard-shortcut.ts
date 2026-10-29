import { useEffect } from "react";

/** Invoke a single unmodified key only when the user is not typing. */
export function useKeyboardShortcut(key: string, action: () => void) {
  useEffect(() => {
    function handleKey(event: KeyboardEvent) {
      if (
        event.defaultPrevented ||
        event.repeat ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey
      )
        return;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable ||
          ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
      )
        return;
      if (event.key.toLowerCase() === key.toLowerCase()) {
        event.preventDefault();
        action();
      }
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [key, action]);
}
