import * as React from "react";
import { Icon } from "../ui/icons.tsx";
import { calendarViews, type CalendarView } from "./model.ts";
import { periodName, viewLabel } from "./views.ts";

const viewKeys: Record<CalendarView, string> = {
  day: "D",
  week: "W",
  month: "M",
  agenda: "A",
};

/** Today, previous and next period, the period's title and the views. */
export function CalendarToolbar({
  view,
  compact,
  title,
  syncing,
  onToday,
  onStep,
  onView,
}: {
  view: CalendarView;
  /** A phone, where the week shows three days. */
  compact: boolean;
  title: string;
  /** Events are refreshing in the background. */
  syncing: boolean;
  onToday: () => void;
  onStep: (direction: number) => void;
  onView: (view: CalendarView) => void;
}) {
  const period = periodName(view, compact);
  return (
    <div className="cal-toolbar">
      <button
        type="button"
        className="cal-today"
        onClick={onToday}
        title="Today (T)"
      >
        Today
      </button>
      <div className="cal-nav">
        <button
          type="button"
          className="cal-icon-button"
          aria-label={`Previous ${period}`}
          title={`Previous ${period} (K)`}
          onClick={() => onStep(-1)}
        >
          <Icon name="chevronLeft" />
        </button>
        <button
          type="button"
          className="cal-icon-button"
          aria-label={`Next ${period}`}
          title={`Next ${period} (J)`}
          onClick={() => onStep(1)}
        >
          <Icon name="chevronRight" />
        </button>
      </div>
      <h1 className="cal-title" aria-live="polite">
        {title}
      </h1>
      {syncing && (
        <output className="cal-sync">
          <span className="visually-hidden">Updating</span>
        </output>
      )}
      <fieldset className="cal-views">
        <legend className="visually-hidden">View</legend>
        {calendarViews.map((item) => (
          <button
            key={item}
            type="button"
            aria-pressed={view === item}
            title={`${viewLabel(item, compact)} view (${viewKeys[item]})`}
            onClick={() => onView(item)}
          >
            {viewLabel(item, compact)}
          </button>
        ))}
      </fieldset>
    </div>
  );
}
