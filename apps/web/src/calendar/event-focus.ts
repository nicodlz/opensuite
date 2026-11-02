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
 * `seriesId` or any chip of that series. Without one, focus goes back to
 * `trigger`, the control that opened the change, or to the calendar surface
 * when there is none, as after a deletion. `wait` keeps the request open for
 * a target that is not known yet, such as the server id of a new event.
 */
export type FocusTarget = {
  seriesId?: string;
  start?: string;
  wait?: boolean;
  trigger?: Element | null;
};
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
 * The chip at the target time, else a stand-in: another chip of the series,
 * else the trigger while it is still on the page, else the surface. `found`
 * is false while a stand-in may still be replaced.
 */
function destination(
  request: Request,
  surface: HTMLElement,
  chips: HTMLElement[],
) {
  const exact = chips.find((chip) => chip.dataset["start"] === request.start);
  const { trigger } = request;
  const opener =
    trigger instanceof HTMLElement &&
    trigger.isConnected &&
    !isNeutral(trigger, surface)
      ? trigger
      : undefined;
  const element = exact ?? chips[0] ?? opener ?? surface;
  const found =
    request.seriesId === undefined ||
    exact !== undefined ||
    (request.start === undefined && chips.length > 0);
  return { element, found };
}

/**
 * Moves focus to an event once its chip is rendered. Chips appear, move or
 * are replaced as optimistic data and server responses arrive, so each render
 * retries until the data has settled. A request is abandoned when the user
 * puts focus somewhere else or presses a key or pointer, and focus never
 * stays on the page body.
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
  useEffect(() => {
    // The user's next key or pointer press ends a request, even one still
    // waiting for its event, so a late chip never takes focus from a dialog
    // or control opened since.
    const end = () => {
      pending.current = null;
    };
    document.addEventListener("keydown", end, true);
    document.addEventListener("pointerdown", end, true);
    return () => {
      document.removeEventListener("keydown", end, true);
      document.removeEventListener("pointerdown", end, true);
    };
  }, []);
  // After every render, in a timer so that it runs after a closing dialog
  // or popover has restored focus to its own trigger.
  useEffect(() => {
    if (!pending.current) return undefined;
    const timer = window.setTimeout(attempt, 0);
    return () => window.clearTimeout(timer);
  });
  return focus;
}
