import * as React from "react";
import type { CalendarEvent } from "@opensuite/contracts";
import { useQuery } from "@tanstack/react-query";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { Button } from "../ui/button.tsx";
import { Icon } from "../ui/icons.tsx";
import {
  eventLabel,
  fetchRange,
  loadError,
  rangeKey,
  titleOf,
  type Colors,
} from "./events.ts";
import {
  eventStart,
  formatEventRange,
  isPending,
  matchesSearch,
  type CalendarView,
  type DateRange,
} from "./model.ts";

// Thirteen months stay within the 400 days that one request may cover.
const monthsAround = 6;
const monthFormat = new Intl.DateTimeFormat(undefined, {
  month: "long",
  year: "numeric",
});

/** Months around the one shown: six before it and six after it. */
export function searchRange(anchor: Date): DateRange {
  const year = anchor.getFullYear();
  const month = anchor.getMonth();
  return {
    start: new Date(year, month - monthsAround, 1),
    end: new Date(year, month + monthsAround + 1, 1),
  };
}

const byStart = (a: CalendarEvent, b: CalendarEvent) =>
  eventStart(a).getTime() - eventStart(b).getTime();

/** One result per series: its next occurrence, else its latest one. */
function nearestPerSeries(events: CalendarEvent[], anchor: Date) {
  const chosen = new Map<string, CalendarEvent>();
  for (const event of events.toSorted(byStart)) {
    const current = chosen.get(event.seriesId);
    if (!current || eventStart(current) < anchor)
      chosen.set(event.seriesId, event);
  }
  return [...chosen.values()].toSorted(byStart);
}

function countOf(count: number) {
  if (count === 0) return "No events";
  return count === 1 ? "1 event" : `${String(count)} events`;
}

function between(range: DateRange) {
  const last = new Date(range.end.getTime() - 1);
  return `between ${monthFormat.format(range.start)} and ${monthFormat.format(last)}`;
}

function byMonth(events: CalendarEvent[]) {
  const groups = new Map<string, CalendarEvent[]>();
  for (const event of events) {
    const title = monthFormat.format(eventStart(event));
    groups.set(title, [...(groups.get(title) ?? []), event]);
  }
  return [...groups];
}

/**
 * The search query and its results panel. Results replace the grid until
 * the search is cleared or another period or view is shown, including the
 * period of a chosen result. A cleared search starts again in the grid, so
 * typing a new one is not interrupted.
 */
export function useSearch(anchor: Date, view: CalendarView) {
  const [query, setQueryState] = useState("");
  const [shownAt, setShownAt] = useState<{
    anchor: Date;
    view: CalendarView;
  } | null>(null);
  const setQuery = useCallback((value: string) => {
    setQueryState(value);
    if (!value.trim()) setShownAt(null);
  }, []);
  return {
    query,
    setQuery,
    open: shownAt?.anchor === anchor && shownAt.view === view,
    show: () => {
      if (query.trim()) setShownAt({ anchor, view });
    },
    hide: () => setShownAt(null),
  };
}

/**
 * Message over an empty period, unless `hidden` (when loading failed). A
 * search offers nearby months; touch screens get no key hint.
 */
export function PeriodEmpty({
  query,
  period,
  hidden,
  onSearch,
}: {
  query: string;
  period: string;
  hidden: boolean;
  onSearch: () => void;
}) {
  const term = query.trim();
  if (hidden) return null;
  return (
    <div className="cal-empty">
      <output>
        {term ? (
          `No events match “${term}” ${period}.`
        ) : (
          <>
            Nothing scheduled {period}. Select a time
            <span className="cal-key-hint"> or press C</span> to add an event.
          </>
        )}
      </output>
      {term && (
        <button type="button" onClick={onSearch}>
          Search nearby months
        </button>
      )}
    </div>
  );
}

function ResultList({
  events,
  colors,
  onPick,
}: {
  events: CalendarEvent[];
  colors: Colors;
  onPick: (event: CalendarEvent) => void;
}) {
  return byMonth(events).map(([month, items]) => (
    <section key={month} className="cal-results-month">
      <h3>{month}</h3>
      <ul>
        {items.map((event) => {
          const color = colors(event.calendarId);
          return (
            <li key={event.id}>
              <button
                type="button"
                className="cal-result"
                aria-label={eventLabel(event, color.name)}
                onClick={() => onPick(event)}
              >
                <span
                  className="cal-dot"
                  style={{ background: color.background }}
                  aria-hidden="true"
                />
                <span className="cal-result-title">{titleOf(event)}</span>
                <span className="cal-result-when">
                  {formatEventRange(event)}
                  {event.location && ` · ${event.location}`}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  ));
}

/** A panel that takes focus when it opens and closes on Escape. */
function usePanel(onClose: () => void) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => ref.current?.focus(), []);
  useEffect(() => {
    const element = ref.current;
    function key(event: KeyboardEvent) {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      onClose();
    }
    element?.addEventListener("keydown", key);
    return () => element?.removeEventListener("keydown", key);
  }, [onClose]);
  return ref;
}

/**
 * Events matching `query` in the months around `anchor`, grouped by month.
 * The list takes focus when it opens; Escape or Close returns to the grid.
 */
export function SearchResults({
  query,
  anchor,
  include,
  colors,
  onPick,
  onClose,
}: {
  query: string;
  anchor: Date;
  include: (event: CalendarEvent) => boolean;
  colors: Colors;
  onPick: (event: CalendarEvent) => void;
  onClose: () => void;
}) {
  const headingId = useId();
  const ref = usePanel(onClose);
  const range = useMemo(() => searchRange(anchor), [anchor]);
  const results = useQuery({
    queryKey: rangeKey(range),
    queryFn: fetchRange(range),
    staleTime: 30_000,
  });
  const term = query.trim();
  const matches = nearestPerSeries(
    (results.data?.events ?? []).filter(
      (event) =>
        !isPending(event) && include(event) && matchesSearch(event, term),
    ),
    anchor,
  );
  const status = results.isError
    ? loadError(results.error)
    : results.isPending
      ? "Searching…"
      : `${countOf(matches.length)} ${between(range)}.`;
  return (
    <section
      ref={ref}
      className="cal-results"
      tabIndex={-1}
      aria-labelledby={headingId}
      aria-busy={results.isPending}
    >
      <div className="cal-results-head">
        <div>
          <h2 id={headingId}>Results for “{term}”</h2>
          <output className="cal-results-status">{status}</output>
        </div>
        {results.isError && (
          <Button
            variant="secondary"
            size="small"
            onClick={() => void results.refetch()}
          >
            Retry
          </Button>
        )}
        <button
          type="button"
          className="cal-icon-button"
          aria-label="Close search results"
          onClick={onClose}
        >
          <Icon name="close" />
        </button>
      </div>
      <ResultList events={matches} colors={colors} onPick={onPick} />
    </section>
  );
}
