import { useLayoutEffect, useRef } from "react";
import {
  addDays,
  periodTitle,
  shiftAnchor,
  startOfDay,
  viewRange,
  type CalendarView,
  type DateRange,
} from "./model.ts";

/**
 * On phones the week view shows three days from the selected one: seven
 * columns of 40 pixels cannot show a title.
 */
export const compactWeekQuery = "(max-width: 599px)";
const compactDays = 3;

const isCompactWeek = (view: CalendarView, compact: boolean) =>
  compact && view === "week";
/** The agenda moves and is named by month, but shows only that month. */
const unitOf = (view: CalendarView) => (view === "agenda" ? "month" : view);

export function visibleRange(
  view: CalendarView,
  anchor: Date,
  firstDay: number,
  compact: boolean,
): DateRange {
  if (view === "agenda") {
    const start = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
    return { start, end: new Date(start.getFullYear(), start.getMonth() + 1) };
  }
  if (!isCompactWeek(view, compact)) return viewRange(view, anchor, firstDay);
  const start = startOfDay(anchor);
  return { start, end: addDays(start, compactDays) };
}

export function shiftVisible(
  view: CalendarView,
  anchor: Date,
  direction: number,
  compact: boolean,
): Date {
  if (!isCompactWeek(view, compact))
    return shiftAnchor(unitOf(view), anchor, direction);
  return addDays(startOfDay(anchor), direction * compactDays);
}

/**
 * Ref for the scrolling time grid. The grid takes keyboard focus so that
 * arrow keys scroll it even on a day without events to tab to. React does
 * not render these attributes, so it leaves them in place.
 */
export function useTimeGridScroller() {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    element.tabIndex = 0;
    element.setAttribute("role", "group");
    element.setAttribute("aria-label", "Events by hour");
  }, []);
  return ref;
}

const labels: Record<CalendarView, string> = {
  day: "Day",
  week: "Week",
  month: "Month",
  agenda: "Agenda",
};

/** Name of a view button and of the calendar surface. */
export function viewLabel(view: CalendarView, compact: boolean) {
  return isCompactWeek(view, compact) ? "3 days" : labels[view];
}

/** Period after "Previous" or "Next". */
export function periodName(view: CalendarView, compact: boolean) {
  return isCompactWeek(view, compact) ? "3 days" : unitOf(view);
}

/** Period at the end of a sentence: "Nothing scheduled this week". */
export function thisPeriod(view: CalendarView, compact: boolean) {
  return isCompactWeek(view, compact) ? "these 3 days" : `this ${unitOf(view)}`;
}

/** Heading of the period shown: a day, a range of days or a month. */
export function viewTitle(view: CalendarView, anchor: Date, range: DateRange) {
  return periodTitle(unitOf(view), anchor, range);
}
