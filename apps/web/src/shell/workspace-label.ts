import { useSyncExternalStore } from "react";

const storageKey = "opensuite-label";
const fallback = "My workspace";
const listeners = new Set<() => void>();

function read() {
  try {
    return localStorage.getItem(storageKey) || fallback;
  } catch {
    return fallback;
  }
}

/** Workspace label kept in this browser, shared by every admin page. */
export function useWorkspaceLabel() {
  return useSyncExternalStore((listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }, read);
}

/** Stores `value`, or the default label for `null`; returns the previous stored value. */
export function storeWorkspaceLabel(value: string | null): string | null {
  const previous = localStorage.getItem(storageKey);
  if (value === null) localStorage.removeItem(storageKey);
  else localStorage.setItem(storageKey, value);
  for (const listener of listeners) listener();
  return previous;
}
