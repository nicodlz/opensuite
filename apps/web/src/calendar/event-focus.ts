import { useIsFetching, useIsMutating } from "@tanstack/react-query";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import { eventsKey } from "./events.ts";

/**
 * Where focus should go after a change: the chip of event `start` in series
 * `seriesId`, any chip of that series, or else the calendar surface. `wait`
 * keeps the request open for a target that is not known yet, such as the
 * server id of an event being created.
 */
export type FocusTarget = { seriesId?: string; start?: string; wait?: boolean };
export type EventFocus = {
  /** Starts a request; focus moves even if a closing dialog restored it elsewhere. */
  request: (target: FocusTarget) => void;
  /** Changes the target of a request that has not been abandoned. */
  retarget: (target: FocusTarget) => void;
};
type Request = FocusTarget & { until: number; placed: Element | null };

// Long enough for a save; a refetch still running extends it.
const patience = 5000;

function chipsOf(surface: HTMLElement, seriesId: string | undefined) {
  if (seriesId === undefined) return [];
  return [
    ...surface.querySelectorAll<HTMLElement>(".cal-event[data-series]"),
  ].filter((chip) => chip.dataset["series"] === seriesId);
}

/** Focus that nobody chose: the page, the main area or the calendar itself. */
function isNeutral(element: Element | null, surface: HTMLElement) {
  return (
    element === null ||
    element === document.body ||
    element === document.documentElement ||
    element === surface ||
    element.tagName === "MAIN"
  );
}

/** Focus left where this request put it, for a place the user chose. */
function userMoved(
  request: Request,
  active: Element | null,
  surface: HTMLElement,
  chips: HTMLElement[],
) {
  return (
    request.placed !== null &&
    active !== request.placed &&
    !isNeutral(active, surface) &&
    !chips.some((chip) => chip === active)
  );
}

/**
 * The chip at the target time, else a stand-in: another chip of the series
 * or the surface. `found` is false while a stand-in may still be replaced.
 */
function destination(
  request: Request,
  surface: HTMLElement,
  chips: HTMLElement[],
) {
  const exact = chips.find((chip) => chip.dataset["start"] === request.start);
  const element = exact ?? chips[0] ?? surface;
  const found =
    request.seriesId === undefined ||
    exact !== undefined ||
    (request.start === undefined && element !== surface);
  return { element, found };
}

/**
 * Moves focus to an event once its chip is rendered. Chips appear, move or
 * are replaced as optimistic data and server responses arrive, so each render
 * retries until the data has settled. A request is abandoned when the user
 * puts focus somewhere else, and focus never stays on the page body.
 */
export function useEventFocus(
  surfaceRef: RefObject<HTMLElement | null>,
): EventFocus {
  const pending = useRef<Request | null>(null);
  const [, rerender] = useState(0);
  const busy = useIsMutating() + useIsFetching({ queryKey: eventsKey }) > 0;
  const focus = useMemo<EventFocus>(
    () => ({
      request: (target) => {
        pending.current = {
          ...target,
          until: Date.now() + patience,
          placed: null,
        };
        rerender((count) => count + 1);
      },
      retarget: (target) => {
        if (!pending.current) return;
        pending.current = { ...pending.current, wait: false, ...target };
        rerender((count) => count + 1);
      },
    }),
    [],
  );
  const attempt = useCallback(() => {
    const current = pending.current;
    const surface = surfaceRef.current;
    if (!current || !surface) return;
    const active = document.activeElement;
    const chips = chipsOf(surface, current.seriesId);
    const expired = Date.now() > current.until && !busy;
    if (expired || userMoved(current, active, surface, chips)) {
      pending.current = null;
      return;
    }
    const { element, found } = destination(current, surface, chips);
    if (active !== element) element.focus();
    current.placed = element;
    if (found && !current.wait && !busy) pending.current = null;
  }, [surfaceRef, busy]);
  // After every render, in a timer so that it runs after a closing dialog
  // or popover has restored focus to its own trigger.
  useEffect(() => {
    if (!pending.current) return undefined;
    const timer = window.setTimeout(attempt, 0);
    return () => window.clearTimeout(timer);
  });
  return focus;
}
