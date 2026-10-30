import type { ThemeChoice } from "@opensuite/design-tokens";
import { useSyncExternalStore } from "react";

const storageKey = "opensuite-theme";
const listeners = new Set<() => void>();

function read(): ThemeChoice {
  const stored = localStorage.getItem(storageKey);
  return stored === "light" || stored === "dark" ? stored : "system";
}
function apply(choice: ThemeChoice) {
  if (choice === "system") delete document.documentElement.dataset["theme"];
  else document.documentElement.dataset["theme"] = choice;
}
let current = read();
apply(current);

export function setTheme(value: string) {
  if (value !== "system" && value !== "light" && value !== "dark") return;
  current = value;
  localStorage.setItem(storageKey, value);
  apply(value);
  for (const listener of listeners) listener();
}
export function useTheme(): ThemeChoice {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => current,
  );
}
