import type { DriveLink, DriveShare } from "@opensuite/contracts";
import type { UseQueryResult } from "@tanstack/react-query";
import type { DriveEntry } from "./model.ts";

export type Access = DriveShare["access"];
export type FocusAfter = (target: () => HTMLElement | null) => void;
export type AccessQuery = UseQueryResult<{
  shares: DriveShare[];
  links: DriveLink[];
}>;
/** What every part of the dialog uses. */
export type Tools = {
  entry: DriveEntry;
  refresh: () => Promise<void>;
  notify: (message: string) => void;
  copy: (value: string, message: string) => void;
  focusAfter: FocusAfter;
};

// After a revocation, focus moves to the same button of the next row, else
// to the control that adds to that list.
export function nextRevoke(
  list: HTMLUListElement | null,
  id: string,
  fallback: () => HTMLElement | null,
) {
  const rows = [...(list?.querySelectorAll<HTMLElement>("li[data-id]") ?? [])];
  const index = rows.findIndex((row) => row.dataset["id"] === id);
  const nextId = (rows[index + 1] ?? rows[index - 1])?.dataset["id"];
  return () =>
    (nextId === undefined
      ? null
      : list?.querySelector<HTMLElement>(
          `li[data-id="${CSS.escape(nextId)}"] .drive-revoke`,
        )) ?? fallback();
}
/** Runs a dialog action with `busy` set and reports a failure. */
export async function attempt(
  setBusy: (busy: boolean) => void,
  run: () => Promise<void>,
  failed: (error: unknown) => void,
) {
  setBusy(true);
  try {
    await run();
  } catch (error) {
    failed(error);
  } finally {
    setBusy(false);
  }
}
