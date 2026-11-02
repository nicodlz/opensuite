import * as React from "react";
import type { CalendarEvent } from "@opensuite/contracts";
import { useLayoutEffect, useRef } from "react";
import { Icon } from "../ui/icons.tsx";
import { eventLabel, titleOf, type Colors } from "./events.ts";
import {
  addDays,
  dayKey,
  eventEnd,
  eventStart,
  formatTime,
  isSpanning,
  overlapsRange,
  sameDay,
  startOfDay,
} from "./model.ts";

/** Events on `day`: all-day and multi-day ones first, then by start. */
export function eventsOn(events: CalendarEvent[], day: Date) {
  return events
    .filter((event) =>
      overlapsRange(event, { start: day, end: addDays(day, 1) }),
    )
    .toSorted(
      (a, b) =>
        Number(isSpanning(b)) - Number(isSpanning(a)) ||
        eventStart(a).getTime() - eventStart(b).getTime(),
    );
}

/** The days of `days` that have events, each with its events. */
export function agendaDays(events: CalendarEvent[], days: Date[]) {
  return days.flatMap((day) => {
    const list = eventsOn(events, day);
    return list.length > 0 ? [{ day, events: list }] : [];
  });
}

/** When an event happens on `day`, which it may start before or end after. */
export function agendaTime(event: CalendarEvent, day: Date) {
  const start = eventStart(event);
  const end = eventEnd(event);
  const before = start < day;
  const after = end > addDays(day, 1);
  if (event.allDay || (before && after)) return "All day";
  if (before) return `Until ${formatTime(end)}`;
  if (after) return `From ${formatTime(start)}`;
  return `${formatTime(start)} – ${formatTime(end)}`;
}

const longDate = (day: Date) =>
  day.toLocaleDateString(undefined, {
    weekday: "long",
    day: "numeric",
    month: "long",
  });

function AgendaEvent({
  event,
  day,
  colors,
  selected,
  onOpen,
}: {
  event: CalendarEvent;
  day: Date;
  colors: Colors;
  selected: boolean;
  onOpen: (event: CalendarEvent, rect: DOMRect) => void;
}) {
  const color = colors(event.calendarId);
  return (
    <button
      type="button"
      className={`cal-event cal-agenda-event ${selected ? "selected" : ""}`}
      aria-label={eventLabel(event, color.name)}
      data-series={event.seriesId}
      data-start={event.start}
      onClick={(click) =>
        onOpen(event, click.currentTarget.getBoundingClientRect())
      }
    >
      <span
        className="cal-dot"
        style={{ background: color.background }}
        aria-hidden="true"
      />
      <span className="cal-agenda-time">{agendaTime(event, day)}</span>
      <span className="cal-event-title">
        {event.recurrence !== "none" && <Icon name="repeat" size={12} />}
        {titleOf(event)}
      </span>
      {event.location && (
        <span className="cal-event-location">{event.location}</span>
      )}
    </button>
  );
}

type AgendaProps = {
  days: Date[];
  events: CalendarEvent[];
  colors: Colors;
  now: Date;
  selectedId: string | null;
  loading: boolean;
  onOpen: (event: CalendarEvent, rect: DOMRect) => void;
  onPickDay: (day: Date) => void;
};

function AgendaList({
  days,
  events,
  colors,
  now,
  selectedId,
  loading,
  onOpen,
  onPickDay,
}: AgendaProps) {
  const listRef = useRef<HTMLOListElement>(null);
  const groups = agendaDays(events, days);
  const today = startOfDay(now);
  const upcoming = groups.find(({ day }) => day >= today)?.day;
  useLayoutEffect(() => {
    const list = listRef.current;
    if (loading || !list) return;
    const target = list.querySelector<HTMLElement>("[data-upcoming]");
    if (target) list.scrollTop = target.offsetTop;
  }, [loading]);
  return (
    <ol ref={listRef} className="cal-agenda" aria-busy={loading}>
      {loading && (
        <li className="cal-agenda-loading" aria-hidden="true">
          <span />
          <span />
          <span />
        </li>
      )}
      {groups.map(({ day, events: list }) => (
        <li
          key={dayKey(day)}
          className="cal-agenda-day"
          data-today={sameDay(day, now) || undefined}
          data-upcoming={day === upcoming || undefined}
        >
          <button
            type="button"
            className="cal-agenda-date"
            aria-label={`${longDate(day)}. Open day view`}
            onClick={() => onPickDay(day)}
          >
            <span className="cal-agenda-weekday">
              {day.toLocaleDateString(undefined, { weekday: "short" })}
            </span>
            <span className="cal-agenda-number">{day.getDate()}</span>
          </button>
          <ul aria-label={longDate(day)}>
            {list.map((event) => (
              <li key={event.id}>
                <AgendaEvent
                  event={event}
                  day={day}
                  colors={colors}
                  selected={event.id === selectedId}
                  onOpen={onOpen}
                />
              </li>
            ))}
          </ul>
        </li>
      ))}
    </ol>
  );
}

/**
 * The events of the period as a list, one item per day with events. Each
 * period opens at today's events, or the next ones, when it contains them.
 */
export function AgendaView(props: AgendaProps) {
  return <AgendaList key={props.days[0]?.getTime()} {...props} />;
}
