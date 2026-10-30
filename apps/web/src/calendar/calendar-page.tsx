import * as React from "react";
import {
  RecurrenceSchema,
  type Calendar,
  type CalendarEvent,
  type EventContent,
} from "@opensuite/contracts";
import { ORPCError } from "@orpc/client";
import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { AppShell } from "../shell/app-shell.tsx";
import { Button } from "../ui/button.tsx";
import { Dialog, DialogContent } from "../ui/dialog.tsx";
import { Icon } from "../ui/icons.tsx";
import { TextField } from "../ui/text-field.tsx";
import { Toast, ToastProvider } from "../ui/toast.tsx";
import { accountId, calendarClient } from "./client.ts";
import {
  addDays,
  applyEventChange,
  calendarPalette,
  calendarViews,
  dateAtMinutes,
  dayKey,
  eventEnd,
  eventStart,
  firstDayOfWeek,
  floorMinutes,
  formFromEvent,
  formatEventRange,
  formatHour,
  formatTime,
  hiddenCounts,
  isCalendarView,
  isSpanning,
  layoutColumns,
  matchesSearch,
  moveTo,
  overlapsRange,
  periodTitle,
  rangeDays,
  recurrenceLabels,
  resizeTo,
  sameDay,
  shiftAnchor,
  shiftDays,
  shiftFormStart,
  snapMinutes,
  spanLanes,
  startOfDay,
  textColorFor,
  timeZoneLabel,
  timedSegments,
  timingFromForm,
  toAllDay,
  viewRange,
  wallMinutes,
  type CalendarView,
  type DateRange,
  type EventChange,
  type EventForm,
  type EventTiming,
  type TimedSegment,
  isPending,
  isRecurring,
} from "./model.ts";
// Vite injects the stylesheet; there is nothing to bind.
// oxlint-disable-next-line import/no-unassigned-import
import "./calendar.css";

const baseKey = ["calendar", accountId];
const eventsKey = [...baseKey, "events"];
const calendarsKey = [...baseKey, "calendars"];
const viewStorage = "opensuite-calendar-view";
const hiddenStorage = "opensuite-calendar-hidden";
/** Pixels per hour; matches `--cal-hour` in calendar.css. */
const HOUR_HEIGHT = 48;
const PX_PER_MINUTE = HOUR_HEIGHT / 60;
const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const viewLabels: Record<CalendarView, string> = {
  day: "Day",
  week: "Week",
  month: "Month",
};
const viewKeys: Record<CalendarView, string> = {
  day: "D",
  week: "W",
  month: "M",
};
const shortcuts: [string, string][] = [
  ["T", "Go to today"],
  ["D / W / M", "Day, week or month view"],
  ["J or N", "Next period"],
  ["K or P", "Previous period"],
  ["C", "Create an event"],
  ["/", "Search events"],
  ["Esc", "Close a popover or cancel a drag"],
  ["?", "Show keyboard shortcuts"],
];

type EventsData = { events: CalendarEvent[] };
type Colors = (calendarId: string) => {
  background: string;
  color: string;
  name: string;
};
type Popover =
  | { kind: "detail"; eventId: string; rect: DOMRect }
  | { kind: "create"; content: EventContent; rect: DOMRect }
  | { kind: "day"; day: Date; rect: DOMRect };
type Editor = { content: EventContent; event?: CalendarEvent };
type Confirm =
  | { kind: "change"; event: CalendarEvent; timing: EventTiming }
  | { kind: "delete"; event: CalendarEvent };

function rangeKey(range: DateRange) {
  return [...eventsKey, range.start.toISOString(), range.end.toISOString()];
}

function fetchRange(range: DateRange) {
  return () =>
    calendarClient.events({
      accountId,
      start: range.start.toISOString(),
      end: range.end.toISOString(),
    });
}

function contentOf(event: CalendarEvent): EventContent {
  const { id: _id, seriesId: _seriesId, ...content } = event;
  return content;
}

function draftContent(
  start: Date,
  end: Date,
  allDay: boolean,
  calendarId: string,
): EventContent {
  return {
    calendarId,
    title: "",
    description: "",
    location: "",
    start: allDay ? toAllDay(start) : start.toISOString(),
    end: allDay ? toAllDay(end) : end.toISOString(),
    allDay,
    timeZone,
    recurrence: "none",
  };
}

function titleOf(event: { title: string }) {
  return event.title.trim() || "(No title)";
}

function eventLabel(event: CalendarEvent, calendarName: string) {
  return [
    titleOf(event),
    formatEventRange(event),
    event.recurrence === "none" ? "" : recurrenceLabels[event.recurrence],
    event.location,
    calendarName,
  ]
    .filter(Boolean)
    .join(", ");
}

function loadError(error: unknown) {
  if (error instanceof ORPCError && error.status === 503)
    return "Calendar is unavailable. Try again in a moment.";
  return "Your calendar could not be loaded.";
}

function readHidden(): Set<string> {
  try {
    const value: unknown = JSON.parse(
      localStorage.getItem(hiddenStorage) ?? "[]",
    );
    return new Set(
      Array.isArray(value)
        ? value.filter((item): item is string => typeof item === "string")
        : [],
    );
  } catch {
    return new Set();
  }
}

function initialView(narrow: boolean): CalendarView {
  const stored = localStorage.getItem(viewStorage);
  if (narrow) return stored === "month" ? "month" : "day";
  return isCalendarView(stored) ? stored : "week";
}

function isTyping(target: EventTarget | null) {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable ||
      ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
  );
}

function useMediaQuery(query: string) {
  const [matches, setMatches] = useState(
    () => window.matchMedia(query).matches,
  );
  useEffect(() => {
    const list = window.matchMedia(query);
    const update = () => setMatches(list.matches);
    list.addEventListener("change", update);
    return () => list.removeEventListener("change", update);
  }, [query]);
  return matches;
}

function useNow() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

/**
 * Follow one pointer until release. Mouse and pen drags start after a few
 * pixels; touch drags need a long press so that swipes keep scrolling.
 * Escape cancels.
 */
function trackPointer(
  down: ReactPointerEvent,
  handlers: {
    move: (event: PointerEvent) => void;
    end: (event: PointerEvent, dragged: boolean) => void;
    cancel: () => void;
  },
) {
  const touch = down.pointerType === "touch";
  const { clientX, clientY, pointerId } = down;
  let held = false;
  let dragged = false;
  const timer = touch
    ? window.setTimeout(() => {
        held = true;
      }, 400)
    : undefined;
  function cleanup() {
    window.clearTimeout(timer);
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", cancel);
    document.removeEventListener("keydown", key, true);
    document.removeEventListener("touchmove", blockScroll);
  }
  function move(event: PointerEvent) {
    if (event.pointerId !== pointerId) return;
    const distance = Math.hypot(
      event.clientX - clientX,
      event.clientY - clientY,
    );
    if (!dragged) {
      if (touch && !held) {
        if (distance > 8) {
          cleanup();
          handlers.cancel();
        }
        return;
      }
      if (distance < 4) return;
      dragged = true;
    }
    handlers.move(event);
  }
  function up(event: PointerEvent) {
    if (event.pointerId !== pointerId) return;
    cleanup();
    handlers.end(event, dragged);
  }
  function cancel() {
    cleanup();
    handlers.cancel();
  }
  function key(event: KeyboardEvent) {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    cancel();
  }
  function blockScroll(event: TouchEvent) {
    if (held) event.preventDefault();
  }
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", cancel);
  document.addEventListener("keydown", key, true);
  document.addEventListener("touchmove", blockScroll, { passive: false });
}

/** Run `action` on a press that is neither a drag nor a scroll gesture. */
function onTap(
  down: ReactPointerEvent<HTMLElement>,
  action: (element: HTMLElement) => void,
) {
  const element = down.currentTarget;
  if (down.button !== 0) return;
  if (down.target instanceof Element && down.target.closest("button")) return;
  trackPointer(down, {
    move: () => undefined,
    end: (_event, dragged) => {
      if (!dragged) action(element);
    },
    cancel: () => undefined,
  });
}

/** Ignore the click that follows a completed drag. */
function useClickGuard() {
  const guard = useRef(false);
  return {
    arm() {
      guard.current = true;
      window.setTimeout(() => {
        guard.current = false;
      }, 0);
    },
    blocked: () => guard.current,
  };
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

/** Cell index under a pointer in a `columns` × `rows` grid element. */
function cellAt(
  element: HTMLElement | null,
  x: number,
  y: number,
  columns: number,
  rows = 1,
) {
  if (!element) return null;
  const rect = element.getBoundingClientRect();
  const column = clamp(
    Math.floor(((x - rect.left) / rect.width) * columns),
    0,
    columns - 1,
  );
  const row = clamp(
    Math.floor(((y - rect.top) / rect.height) * rows),
    0,
    rows - 1,
  );
  return row * columns + column;
}

export function CalendarPage() {
  return (
    <ToastProvider>
      <CalendarWorkspace />
    </ToastProvider>
  );
}

function CalendarWorkspace() {
  const queryClient = useQueryClient();
  const narrow = useMediaQuery("(max-width: 900px)");
  const [view, setViewState] = useState<CalendarView>(() =>
    initialView(narrow),
  );
  const [anchor, setAnchor] = useState(() => startOfDay(new Date()));
  const [search, setSearch] = useState("");
  const [hidden, setHidden] = useState(readHidden);
  const [popover, setPopover] = useState<Popover | null>(null);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [help, setHelp] = useState(false);
  const [newCalendar, setNewCalendar] = useState(false);
  const [notice, setNotice] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const firstDay = useMemo(() => firstDayOfWeek(), []);
  const now = useNow();
  const today = startOfDay(now);
  const range = useMemo(
    () => viewRange(view, anchor, firstDay),
    [view, anchor, firstDay],
  );
  const days = useMemo(() => rangeDays(range), [range]);

  const calendars = useQuery({
    queryKey: calendarsKey,
    queryFn: () => calendarClient.calendars({ accountId }),
    staleTime: 30_000,
    refetchInterval: false,
  });
  const events = useQuery({
    queryKey: rangeKey(range),
    queryFn: fetchRange(range),
    placeholderData: keepPreviousData,
    staleTime: 30_000,
    refetchInterval: false,
  });
  const loaded = events.isSuccess && !events.isPlaceholderData;
  useEffect(() => {
    if (!loaded) return;
    for (const direction of [-1, 1]) {
      const next = viewRange(
        view,
        shiftAnchor(view, anchor, direction),
        firstDay,
      );
      void queryClient.prefetchQuery({
        queryKey: rangeKey(next),
        queryFn: fetchRange(next),
        staleTime: 30_000,
      });
    }
  }, [loaded, view, anchor, firstDay, queryClient]);

  const calendarList = useMemo(
    () => calendars.data?.calendars ?? [],
    [calendars.data],
  );
  const colors: Colors = useCallback(
    (calendarId) => {
      const calendar = calendarList.find((item) => item.id === calendarId);
      const background = calendar?.color ?? "#6d4bd8";
      return {
        background,
        color: textColorFor(background),
        name: calendar?.name ?? "Calendar",
      };
    },
    [calendarList],
  );
  const defaultCalendarId =
    calendarList.find((item) => item.isDefault && !hidden.has(item.id))?.id ??
    calendarList.find((item) => !hidden.has(item.id))?.id ??
    calendarList[0]?.id ??
    "";
  const pending = confirm?.kind === "change" ? confirm : null;
  const visible = useMemo(
    () =>
      withTiming(
        (events.data?.events ?? []).filter(
          (event) =>
            !hidden.has(event.calendarId) && matchesSearch(event, search),
        ),
        pending && { id: pending.event.id, timing: pending.timing },
      ),
    [events.data, hidden, search, pending],
  );
  const inRange = visible.filter((event) => overlapsRange(event, range));

  const mutation = useMutation({
    mutationFn: async (change: EventChange): Promise<CalendarEvent | null> => {
      if (change.type === "create")
        return calendarClient.createEvent({ accountId, event: change.content });
      if (change.type === "update")
        return calendarClient.updateEvent({
          accountId,
          eventId: change.event.id,
          event: change.content,
        });
      await calendarClient.deleteEvent({ accountId, eventId: change.event.id });
      return null;
    },
    onMutate: async (change) => {
      await queryClient.cancelQueries({ queryKey: eventsKey });
      const snapshot = queryClient.getQueriesData<EventsData>({
        queryKey: eventsKey,
      });
      queryClient.setQueriesData<EventsData>({ queryKey: eventsKey }, (data) =>
        data ? { events: applyEventChange(data.events, change) } : data,
      );
      return { snapshot };
    },
    onSuccess: (saved, change) => {
      if (change.type !== "create" || !saved) return;
      queryClient.setQueriesData<EventsData>({ queryKey: eventsKey }, (data) =>
        data
          ? {
              events: data.events.map((event) =>
                event.id === change.id ? saved : event,
              ),
            }
          : data,
      );
    },
    onError: (error, change, context) => {
      for (const [key, data] of context?.snapshot ?? [])
        queryClient.setQueryData(key, data);
      const action =
        change.type === "delete"
          ? "deleted"
          : change.type === "create"
            ? "created"
            : "saved";
      setNotice(
        error instanceof ORPCError && error.status === 503
          ? "Calendar is unavailable. Your change was undone."
          : `The event could not be ${action}. Your change was undone.`,
      );
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: eventsKey }),
  });
  const createCalendar = useMutation({
    mutationFn: (input: { name: string; color: string }) =>
      calendarClient.createCalendar({ accountId, ...input }),
    onSuccess: () => {
      setNewCalendar(false);
      return queryClient.invalidateQueries({ queryKey: calendarsKey });
    },
  });

  function setView(next: CalendarView) {
    localStorage.setItem(viewStorage, next);
    setViewState(next);
    setPopover(null);
  }
  function go(direction: number) {
    setAnchor((current) => shiftAnchor(view, current, direction));
    setPopover(null);
  }
  function goToday() {
    setAnchor(startOfDay(new Date()));
    setPopover(null);
  }
  function openDay(day: Date) {
    setAnchor(startOfDay(day));
    setView("day");
  }
  function toggleCalendar(id: string) {
    setHidden((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      localStorage.setItem(hiddenStorage, JSON.stringify([...next]));
      return next;
    });
  }
  function openCreateEditor() {
    const base = days.some((day) => sameDay(day, today))
      ? dateAtMinutes(today, Math.ceil((wallMinutes(now) + 1) / 30) * 30)
      : dateAtMinutes(startOfDay(range.start), 9 * 60);
    const start =
      view === "month" && !sameDay(anchor, today)
        ? dateAtMinutes(
            new Date(anchor.getFullYear(), anchor.getMonth(), 1),
            9 * 60,
          )
        : base;
    setPopover(null);
    setEditor({
      content: draftContent(
        start,
        new Date(start.getTime() + 3_600_000),
        false,
        defaultCalendarId,
      ),
    });
  }
  function requestTiming(event: CalendarEvent, timing: EventTiming) {
    if (isPending(event)) return;
    if (!isRecurring(event)) saveTiming(event, timing);
    else setConfirm({ kind: "change", event, timing });
  }
  function saveTiming(event: CalendarEvent, timing: EventTiming) {
    mutation.mutate({
      type: "update",
      event,
      content: { ...contentOf(event), ...timing },
    });
  }
  function saveEditor(content: EventContent) {
    const current = editor?.event;
    if (current) mutation.mutate({ type: "update", event: current, content });
    else
      mutation.mutate({
        type: "create",
        id: `draft-${crypto.randomUUID()}`,
        content,
      });
    setEditor(null);
  }
  function createQuick(content: EventContent) {
    mutation.mutate({
      type: "create",
      id: `draft-${crypto.randomUUID()}`,
      content,
    });
    setPopover(null);
  }
  function remove(event: CalendarEvent) {
    if (!isPending(event)) mutation.mutate({ type: "delete", event });
    setConfirm(null);
    setPopover(null);
  }

  const modal = editor !== null || confirm !== null || help || newCalendar;
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (
        event.defaultPrevented ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey
      )
        return;
      if (modal || isTyping(event.target)) return;
      if (event.key === "Escape") {
        if (popover) {
          event.preventDefault();
          setPopover(null);
        }
        return;
      }
      if (event.repeat) return;
      const actions: Record<string, () => void> = {
        t: goToday,
        d: () => setView("day"),
        w: () => setView("week"),
        m: () => setView("month"),
        j: () => go(1),
        n: () => go(1),
        k: () => go(-1),
        p: () => go(-1),
        c: openCreateEditor,
        "/": () => searchRef.current?.focus(),
        "?": () => setHelp(true),
      };
      const action =
        actions[event.key.length === 1 ? event.key.toLowerCase() : ""];
      if (!action) return;
      event.preventDefault();
      action();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  const closePopover = useCallback(() => setPopover(null), []);
  const popoverOpen = useRef(false);
  popoverOpen.current = popover !== null;
  const blockCreate = useCallback(() => popoverOpen.current, []);
  const draft =
    popover?.kind === "create"
      ? { ...popover.content, id: "draft", seriesId: "draft" }
      : null;
  const viewProps: ViewProps = {
    days,
    events: visible,
    colors,
    now,
    draft,
    selectedId: popover?.kind === "detail" ? popover.eventId : null,
    loading: events.isPending,
    blockCreate,
    onCreate: (start, end, allDay, rect) =>
      setPopover({
        kind: "create",
        content: draftContent(start, end, allDay, defaultCalendarId),
        rect,
      }),
    onOpen: (event, rect) =>
      setPopover({ kind: "detail", eventId: event.id, rect }),
    onChange: requestTiming,
    onPickDay: openDay,
    onMore: (day, rect) => setPopover({ kind: "day", day, rect }),
  };
  const detail =
    popover?.kind === "detail"
      ? (events.data?.events.find(
          (event) => event.id === popover.eventId && !isPending(event),
        ) ?? null)
      : null;
  const periodName = view === "day" ? "day" : view;
  const title = periodTitle(view, anchor, range);

  return (
    <AppShell
      product="calendar"
      mainId="calendar-main"
      mainClassName="cal-main"
      primaryAction={{
        label: "Create",
        icon: "plus",
        shortcut: "C",
        onClick: openCreateEditor,
      }}
      sidebar={
        <>
          <MiniMonth
            key={`${anchor.getFullYear()}-${anchor.getMonth()}`}
            anchor={anchor}
            range={range}
            monthOnly={view === "month"}
            today={today}
            firstDay={firstDay}
            onPick={(day) => {
              setAnchor(startOfDay(day));
              setPopover(null);
            }}
          />
          <div className="shell-nav-heading">
            <span>My calendars</span>
            <button
              type="button"
              aria-label="Create calendar"
              title="Create calendar"
              onClick={() => setNewCalendar(true)}
            >
              <Icon name="plus" size={16} />
            </button>
          </div>
          {calendars.isPending ? (
            <div className="cal-list-skeleton" aria-hidden="true">
              <span />
              <span />
            </div>
          ) : (
            <ul className="cal-list" aria-label="My calendars">
              {calendarList.map((calendar) => (
                <CalendarToggle
                  key={calendar.id}
                  calendar={calendar}
                  shown={!hidden.has(calendar.id)}
                  onToggle={() => toggleCalendar(calendar.id)}
                />
              ))}
            </ul>
          )}
        </>
      }
      search={
        <div className="shell-searchbox">
          <Icon name="search" />
          <label className="visually-hidden" htmlFor="calendar-search">
            Search events
          </label>
          <input
            ref={searchRef}
            id="calendar-search"
            type="search"
            placeholder="Search events"
            autoComplete="off"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape" && search) {
                event.preventDefault();
                setSearch("");
              }
            }}
          />
          {search && (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => {
                setSearch("");
                searchRef.current?.focus();
              }}
            >
              <Icon name="close" size={16} />
            </button>
          )}
        </div>
      }
      actions={
        <button
          type="button"
          className="shell-icon-button"
          aria-label="Keyboard shortcuts"
          title="Keyboard shortcuts (?)"
          onClick={() => setHelp(true)}
        >
          <Icon name="help" />
        </button>
      }
    >
      <div className="cal-page">
        <div className="cal-toolbar">
          <button
            type="button"
            className="cal-today"
            onClick={goToday}
            title="Today (T)"
          >
            Today
          </button>
          <div className="cal-nav">
            <button
              type="button"
              className="cal-icon-button"
              aria-label={`Previous ${periodName}`}
              title={`Previous ${periodName} (K)`}
              onClick={() => go(-1)}
            >
              <Icon name="chevronLeft" />
            </button>
            <button
              type="button"
              className="cal-icon-button"
              aria-label={`Next ${periodName}`}
              title={`Next ${periodName} (J)`}
              onClick={() => go(1)}
            >
              <Icon name="chevronRight" />
            </button>
          </div>
          <h1 className="cal-title" aria-live="polite">
            {title}
          </h1>
          {events.isFetching && !events.isPending && (
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
                title={`${viewLabels[item]} view (${viewKeys[item]})`}
                onClick={() => setView(item)}
              >
                {viewLabels[item]}
              </button>
            ))}
          </fieldset>
        </div>
        {events.isError && (
          <div className="cal-banner" role="alert">
            <span>{loadError(events.error)}</span>
            <Button
              variant="secondary"
              size="small"
              onClick={() => void events.refetch()}
            >
              Retry
            </Button>
          </div>
        )}
        <section
          className={`cal-surface cal-surface-${view}`}
          aria-label={`${viewLabels[view]} of ${title}`}
          aria-busy={events.isPending}
        >
          {view === "month" ? (
            <MonthView {...viewProps} month={anchor.getMonth()} />
          ) : (
            <TimeGrid key={view} {...viewProps} />
          )}
          {!events.isPending && !events.isError && inRange.length === 0 && (
            <output className="cal-empty">
              {search.trim()
                ? `No events match “${search.trim()}” this ${periodName}.`
                : `Nothing scheduled this ${periodName}. Select a time or press C to add an event.`}
            </output>
          )}
        </section>
      </div>

      {popover?.kind === "detail" && detail && (
        <EventDetails
          event={detail}
          rect={popover.rect}
          colors={colors}
          onClose={closePopover}
          onEdit={() => {
            setPopover(null);
            setEditor({ content: contentOf(detail), event: detail });
          }}
          onDelete={() => {
            setPopover(null);
            setConfirm({ kind: "delete", event: detail });
          }}
        />
      )}
      {popover?.kind === "create" && (
        <QuickCreate
          key={popover.content.start}
          content={popover.content}
          rect={popover.rect}
          calendars={calendarList}
          onClose={closePopover}
          onSave={createQuick}
          onMore={(content) => {
            setPopover(null);
            setEditor({ content });
          }}
        />
      )}
      {popover?.kind === "day" && (
        <DayPopover
          day={popover.day}
          rect={popover.rect}
          events={visible}
          colors={colors}
          onClose={closePopover}
          onPickDay={openDay}
          onOpen={(event, rect) =>
            setPopover({ kind: "detail", eventId: event.id, rect })
          }
        />
      )}

      <Dialog
        open={editor !== null}
        onOpenChange={(open) => !open && setEditor(null)}
      >
        {editor && (
          <DialogContent
            title={editor.event ? "Edit event" : "New event"}
            description={
              editor.event && isRecurring(editor.event)
                ? "Changes apply to every occurrence of this event."
                : `Times use your time zone (${timeZone}).`
            }
          >
            <EventEditor
              content={editor.content}
              calendars={calendarList}
              onCancel={() => setEditor(null)}
              onSave={saveEditor}
            />
          </DialogContent>
        )}
      </Dialog>

      <Dialog
        open={confirm !== null}
        onOpenChange={(open) => !open && setConfirm(null)}
      >
        {confirm && (
          <DialogContent
            title={
              confirm.kind === "delete"
                ? !isRecurring(confirm.event)
                  ? "Delete event?"
                  : "Delete recurring event?"
                : "Change recurring event?"
            }
            description={
              confirm.kind === "delete"
                ? !isRecurring(confirm.event)
                  ? `“${titleOf(confirm.event)}” will be removed from your calendar.`
                  : `This deletes every occurrence of “${titleOf(confirm.event)}”.`
                : `This changes every occurrence of “${titleOf(confirm.event)}”.`
            }
          >
            <div className="dialog-actions cal-dialog-actions">
              <Button variant="ghost" onClick={() => setConfirm(null)}>
                Cancel
              </Button>
              {confirm.kind === "delete" ? (
                <Button
                  className="cal-danger"
                  onClick={() => remove(confirm.event)}
                >
                  {!isRecurring(confirm.event)
                    ? "Delete"
                    : "Delete all occurrences"}
                </Button>
              ) : (
                <Button
                  onClick={() => {
                    saveTiming(confirm.event, confirm.timing);
                    setConfirm(null);
                  }}
                >
                  Change all occurrences
                </Button>
              )}
            </div>
          </DialogContent>
        )}
      </Dialog>

      <Dialog open={newCalendar} onOpenChange={setNewCalendar}>
        <DialogContent
          title="New calendar"
          description="Choose a name and a color for its events."
        >
          <NewCalendarForm
            busy={createCalendar.isPending}
            error={
              createCalendar.isError ? "The calendar could not be created." : ""
            }
            onCreate={(input) => createCalendar.mutate(input)}
          />
        </DialogContent>
      </Dialog>

      <Dialog open={help} onOpenChange={setHelp}>
        <DialogContent
          title="Keyboard shortcuts"
          description="Shortcuts work when you are not typing in a field."
        >
          <dl className="cal-shortcuts">
            {shortcuts.map(([keys, label]) => (
              <div key={keys}>
                <dt>
                  {keys
                    .split(" ")
                    .map((part) =>
                      ["/", "or"].includes(part) && keys !== "/" ? (
                        <span key={part}> {part} </span>
                      ) : (
                        <kbd key={part}>{part}</kbd>
                      ),
                    )}
                </dt>
                <dd>{label}</dd>
              </div>
            ))}
          </dl>
        </DialogContent>
      </Dialog>

      <Toast
        open={notice !== ""}
        onOpenChange={(open) => !open && setNotice("")}
        message={notice}
      />
    </AppShell>
  );
}

type ViewProps = {
  days: Date[];
  events: CalendarEvent[];
  colors: Colors;
  now: Date;
  draft: CalendarEvent | null;
  selectedId: string | null;
  loading: boolean;
  blockCreate: () => boolean;
  onCreate: (start: Date, end: Date, allDay: boolean, rect: DOMRect) => void;
  onOpen: (event: CalendarEvent, rect: DOMRect) => void;
  onChange: (event: CalendarEvent, timing: EventTiming) => void;
  onPickDay: (day: Date) => void;
  onMore: (day: Date, rect: DOMRect) => void;
};

type GridDrag =
  | { mode: "create"; day: number; from: number; to: number }
  | { mode: "move"; event: CalendarEvent; timing: EventTiming };

/** Events with one occurrence shown at a provisional time. */
function withTiming(
  events: CalendarEvent[],
  override: { id: string; timing: EventTiming } | null,
) {
  if (!override) return events;
  return events.map((event) =>
    event.id === override.id ? { ...event, ...override.timing } : event,
  );
}

function dragOverride(drag: GridDrag | null) {
  return drag?.mode === "move"
    ? { id: drag.event.id, timing: drag.timing }
    : null;
}

function TimeGrid({
  days,
  events,
  colors,
  now,
  draft,
  selectedId,
  loading,
  blockCreate,
  onCreate,
  onOpen,
  onChange,
  onPickDay,
}: ViewProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const columnsRef = useRef<HTMLDivElement>(null);
  const allDayRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<GridDrag | null>(null);
  const [expanded, setExpanded] = useState(false);
  const guard = useClickGuard();
  const count = days.length;
  const shown = withTiming(events, dragOverride(drag));
  const first = days[0] ?? startOfDay(now);
  const todayIndex = days.findIndex((day) => sameDay(day, now));
  const columns = `repeat(${count}, minmax(0, 1fr))`;

  // Start at 07:00, or just above the current time when today is visible.
  const [initialMinute] = useState(() =>
    todayIndex >= 0 ? Math.max(7 * 60, wallMinutes(now) - 120) : 7 * 60,
  );
  const autoScrolled = useRef<number | null>(null);
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    // Repeat once the first events arrive unless the user has scrolled.
    if (
      autoScrolled.current !== null &&
      element.scrollTop !== autoScrolled.current
    )
      return;
    element.scrollTop = Math.max(0, initialMinute * PX_PER_MINUTE - 12);
    // Once events are loaded the position belongs to the user.
    autoScrolled.current = loading ? element.scrollTop : -1;
  }, [initialMinute, loading]);

  const segments = useMemo(() => timedSegments(shown, days), [shown, days]);
  const byDay = useMemo(
    () =>
      days.map((_, index) =>
        layoutColumns(
          segments.filter((segment) => segment.day === index),
          22 / PX_PER_MINUTE,
        ),
      ),
    [segments, days],
  );
  const spanning = useMemo(
    () => spanLanes(shown.filter(isSpanning), first, count),
    [shown, first, count],
  );
  const collapsedLanes = spanning.lanes > 3 && !expanded ? 2 : spanning.lanes;
  const hidden = hiddenCounts(spanning.items, count, collapsedLanes);
  const draftSegments =
    draft && !isSpanning(draft) ? timedSegments([draft], days) : [];
  const draftSpan =
    draft && isSpanning(draft)
      ? spanLanes([draft], first, count).items[0]
      : undefined;

  function point(x: number, y: number) {
    const element = columnsRef.current;
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    return {
      day: clamp(
        Math.floor(((x - rect.left) / rect.width) * count),
        0,
        count - 1,
      ),
      minute: clamp((y - rect.top) / PX_PER_MINUTE, 0, 1440),
    };
  }
  function slotRect(day: number, from: number, to: number) {
    const rect = columnsRef.current?.getBoundingClientRect() ?? new DOMRect();
    const width = rect.width / count;
    return new DOMRect(
      rect.left + width * day,
      rect.top + from * PX_PER_MINUTE,
      width,
      (to - from) * PX_PER_MINUTE,
    );
  }
  function autoscroll(event: PointerEvent) {
    const element = scrollRef.current;
    if (!element) return;
    const rect = element.getBoundingClientRect();
    if (event.clientY < rect.top + 90) element.scrollTop -= 12;
    else if (event.clientY > rect.bottom - 30) element.scrollTop += 12;
  }

  function startCreate(down: ReactPointerEvent<HTMLDivElement>) {
    if (down.button !== 0 || blockCreate()) return;
    if (down.target instanceof Element && down.target.closest(".cal-event"))
      return;
    const start = point(down.clientX, down.clientY);
    if (!start) return;
    const anchor = floorMinutes(start.minute, 30);
    let slot = { from: anchor, to: Math.min(1440, anchor + 60) };
    trackPointer(down, {
      move: (event) => {
        const current = point(event.clientX, event.clientY);
        if (!current) return;
        const other = floorMinutes(current.minute, 30);
        slot = {
          from: Math.min(anchor, other),
          to: Math.max(anchor, other) + 30,
        };
        setDrag({ mode: "create", day: start.day, ...slot });
        autoscroll(event);
      },
      end: () => {
        setDrag(null);
        const day = days[start.day];
        if (!day) return;
        onCreate(
          dateAtMinutes(day, slot.from),
          dateAtMinutes(day, slot.to),
          false,
          slotRect(start.day, slot.from, slot.to),
        );
      },
      cancel: () => setDrag(null),
    });
  }

  function startMove(
    down: ReactPointerEvent<HTMLElement>,
    event: CalendarEvent,
    mode: "move" | "resize",
  ) {
    if (down.button !== 0) return;
    if (mode === "resize") down.stopPropagation();
    const grab = point(down.clientX, down.clientY);
    const grabDay = grab ? days[grab.day] : undefined;
    if (!grab || !grabDay) return;
    const offset =
      dateAtMinutes(grabDay, grab.minute).getTime() -
      eventStart(event).getTime();
    let timing: EventTiming | null = null;
    trackPointer(down, {
      move: (pointer) => {
        const current = point(pointer.clientX, pointer.clientY);
        const day = current ? days[current.day] : undefined;
        if (!current || !day) return;
        if (mode === "resize") {
          timing = resizeTo(
            event,
            dateAtMinutes(day, snapMinutes(current.minute, 15)),
          );
        } else {
          const raw = new Date(
            dateAtMinutes(day, current.minute).getTime() - offset,
          );
          timing = moveTo(
            event,
            dateAtMinutes(startOfDay(raw), snapMinutes(wallMinutes(raw), 15)),
          );
        }
        setDrag({ mode: "move", event, timing });
        autoscroll(pointer);
      },
      end: (_pointer, dragged) => {
        setDrag(null);
        if (!dragged) return;
        guard.arm();
        if (
          timing &&
          (timing.start !== event.start || timing.end !== event.end)
        )
          onChange(event, timing);
      },
      cancel: () => setDrag(null),
    });
  }

  function startDayMove(
    down: ReactPointerEvent<HTMLElement>,
    event: CalendarEvent,
  ) {
    if (down.button !== 0) return;
    const grab = cellAt(allDayRef.current, down.clientX, down.clientY, count);
    if (grab === null) return;
    let timing: EventTiming | null = null;
    trackPointer(down, {
      move: (pointer) => {
        const cell = cellAt(
          allDayRef.current,
          pointer.clientX,
          pointer.clientY,
          count,
        );
        if (cell === null) return;
        timing = shiftDays(event, cell - grab);
        setDrag({ mode: "move", event, timing });
      },
      end: (_pointer, dragged) => {
        setDrag(null);
        if (!dragged) return;
        guard.arm();
        if (timing && timing.start !== event.start) onChange(event, timing);
      },
      cancel: () => setDrag(null),
    });
  }

  function open(event: CalendarEvent, element: HTMLElement) {
    if (guard.blocked()) return;
    onOpen(event, element.getBoundingClientRect());
  }

  return (
    <div className="cal-scroll" ref={scrollRef}>
      <div className="cal-head">
        <div className="cal-row">
          <div className="cal-gutter-label cal-zone">
            {timeZoneLabel(first)}
          </div>
          <div
            className="cal-dayheads"
            style={{ gridTemplateColumns: columns }}
          >
            {days.map((day) => {
              const content = (
                <>
                  <span className="cal-dayhead-weekday">
                    {day.toLocaleDateString(undefined, { weekday: "short" })}
                  </span>
                  <span className="cal-dayhead-number">{day.getDate()}</span>
                </>
              );
              const label = day.toLocaleDateString(undefined, {
                weekday: "long",
                day: "numeric",
                month: "long",
              });
              const today = sameDay(day, now);
              return count > 1 ? (
                <button
                  key={dayKey(day)}
                  type="button"
                  className="cal-dayhead"
                  data-today={today || undefined}
                  aria-label={`${label}${today ? ", today" : ""}. Open day view`}
                  aria-current={today ? "date" : undefined}
                  onClick={() => onPickDay(day)}
                >
                  {content}
                </button>
              ) : (
                <div
                  key={dayKey(day)}
                  className="cal-dayhead"
                  data-today={today || undefined}
                  aria-current={today ? "date" : undefined}
                >
                  {content}
                </div>
              );
            })}
          </div>
        </div>
        <div className="cal-row cal-allday-row">
          <div className="cal-gutter-label">
            <span>All day</span>
            {spanning.lanes > 3 && (
              <button
                type="button"
                className="cal-allday-toggle"
                aria-expanded={expanded}
                aria-label={
                  expanded
                    ? "Show fewer all-day events"
                    : "Show all all-day events"
                }
                onClick={() => setExpanded((value) => !value)}
              >
                <Icon
                  name="chevronDown"
                  size={14}
                  style={expanded ? { transform: "rotate(180deg)" } : undefined}
                />
              </button>
            )}
          </div>
          <div
            className="cal-allday"
            ref={allDayRef}
            style={{
              gridTemplateColumns: columns,
              gridTemplateRows: `repeat(${Math.max(1, collapsedLanes + (hidden.some(Boolean) ? 1 : 0))}, 24px)`,
            }}
          >
            {days.map((day, index) => (
              <div
                key={dayKey(day)}
                className="cal-allday-cell"
                data-today={(count > 1 && sameDay(day, now)) || undefined}
                style={{ gridColumn: index + 1, gridRow: "1 / -1" }}
                onPointerDown={(down) => {
                  if (blockCreate()) return;
                  onTap(down, (element) =>
                    onCreate(
                      day,
                      addDays(day, 1),
                      true,
                      element.getBoundingClientRect(),
                    ),
                  );
                }}
              />
            ))}
            {spanning.items
              .filter((item) => item.lane < collapsedLanes)
              .map((item) => (
                <EventChip
                  key={item.event.id}
                  event={item.event}
                  colors={colors}
                  variant="bar"
                  selected={selectedId === item.event.id}
                  dragging={
                    drag?.mode === "move" && drag.event.id === item.event.id
                  }
                  className={`${item.startsBefore ? "cut-start" : ""} ${item.endsAfter ? "cut-end" : ""}`}
                  style={{
                    gridColumn: `${item.startColumn + 1} / ${item.endColumn + 1}`,
                    gridRow: item.lane + 1,
                  }}
                  onOpen={open}
                  onPointerDown={(down) => startDayMove(down, item.event)}
                />
              ))}
            {hidden.map((hiddenCount, index) =>
              hiddenCount > 0 ? (
                <button
                  key={dayKey(days[index] ?? first)}
                  type="button"
                  className="cal-more"
                  style={{ gridColumn: index + 1, gridRow: collapsedLanes + 1 }}
                  aria-label={`${hiddenCount} more all-day events`}
                  onClick={() => setExpanded(true)}
                >
                  +{hiddenCount}
                  <span className="cal-more-word"> more</span>
                </button>
              ) : null,
            )}
            {draftSpan && (
              <div
                className="cal-event cal-event-bar cal-draft"
                aria-hidden="true"
                style={{
                  gridColumn: `${draftSpan.startColumn + 1} / ${draftSpan.endColumn + 1}`,
                  gridRow: 1,
                }}
              >
                <span className="cal-event-title">
                  {draft?.title || "(No title)"}
                </span>
              </div>
            )}
          </div>
        </div>
      </div>
      <div className="cal-row cal-body">
        <div className="cal-gutter" aria-hidden="true">
          {Array.from({ length: 23 }, (_, index) => (
            <span key={index} style={{ top: (index + 1) * HOUR_HEIGHT }}>
              {formatHour(index + 1)}
            </span>
          ))}
        </div>
        <div
          className="cal-columns"
          ref={columnsRef}
          style={{ gridTemplateColumns: columns }}
          onPointerDown={startCreate}
        >
          {days.map((day, index) => (
            <div
              key={dayKey(day)}
              className="cal-column"
              data-today={(count > 1 && index === todayIndex) || undefined}
              data-weekend={
                day.getDay() === 0 || day.getDay() === 6 || undefined
              }
            >
              {loading && index % 2 === 0 && (
                <div
                  className="cal-skeleton"
                  aria-hidden="true"
                  style={{
                    top: (9 + (index % 3)) * HOUR_HEIGHT,
                    height: HOUR_HEIGHT * (1 + (index % 2)),
                  }}
                />
              )}
              {byDay[index]?.map((segment) => (
                <TimedChip
                  key={`${segment.event.id}-${segment.day}`}
                  segment={segment}
                  colors={colors}
                  selected={selectedId === segment.event.id}
                  dragging={
                    drag?.mode === "move" && drag.event.id === segment.event.id
                  }
                  onOpen={open}
                  onMove={(down) => startMove(down, segment.event, "move")}
                  onResize={(down) => startMove(down, segment.event, "resize")}
                />
              ))}
              {drag?.mode === "create" && drag.day === index && (
                <div
                  className="cal-event cal-draft"
                  aria-hidden="true"
                  style={{
                    top: drag.from * PX_PER_MINUTE,
                    height: (drag.to - drag.from) * PX_PER_MINUTE,
                  }}
                >
                  <span className="cal-event-time">
                    {formatTime(dateAtMinutes(day, drag.from))} –{" "}
                    {formatTime(dateAtMinutes(day, drag.to))}
                  </span>
                </div>
              )}
              {draftSegments
                .filter((segment) => segment.day === index)
                .map((segment) => (
                  <div
                    key="draft"
                    className="cal-event cal-draft"
                    aria-hidden="true"
                    style={{
                      top: segment.startMinute * PX_PER_MINUTE,
                      height: Math.max(
                        20,
                        (segment.endMinute - segment.startMinute) *
                          PX_PER_MINUTE,
                      ),
                    }}
                  >
                    <span className="cal-event-title">
                      {draft?.title || "(No title)"}
                    </span>
                    <span className="cal-event-time">
                      {formatTime(eventStart(segment.event))} –{" "}
                      {formatTime(eventEnd(segment.event))}
                    </span>
                  </div>
                ))}
              {index === todayIndex && (
                <div
                  className="cal-now"
                  aria-hidden="true"
                  style={{ top: wallMinutes(now) * PX_PER_MINUTE }}
                />
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function TimedChip({
  segment,
  colors,
  selected,
  dragging,
  onOpen,
  onMove,
  onResize,
}: {
  segment: TimedSegment & { column: number; columns: number; span: number };
  colors: Colors;
  selected: boolean;
  dragging: boolean;
  onOpen: (event: CalendarEvent, element: HTMLElement) => void;
  onMove: (down: ReactPointerEvent<HTMLElement>) => void;
  onResize: (down: ReactPointerEvent<HTMLElement>) => void;
}) {
  const { event, startMinute, endMinute, column, columns, span } = segment;
  const height = Math.max(20, (endMinute - startMinute) * PX_PER_MINUTE - 2);
  const compact = height < 38;
  const start = eventStart(event);
  const end = eventEnd(event);
  const time = segment.startsBefore
    ? `until ${formatTime(end)}`
    : compact
      ? formatTime(start)
      : `${formatTime(start)} – ${formatTime(end)}`;
  const color = colors(event.calendarId);
  return (
    <button
      type="button"
      className={`cal-event cal-event-timed ${compact ? "compact" : ""} ${selected ? "selected" : ""} ${dragging ? "dragging" : ""}`}
      style={{
        top: startMinute * PX_PER_MINUTE,
        height,
        left: `${(column / columns) * 100}%`,
        width: `calc(${(span / columns) * 100}% - 3px)`,
        background: color.background,
        color: color.color,
      }}
      aria-label={eventLabel(event, color.name)}
      onClick={(click) => onOpen(event, click.currentTarget)}
      onPointerDown={onMove}
      onContextMenu={(menu) => menu.preventDefault()}
    >
      <span className="cal-event-title">
        {event.recurrence !== "none" && <Icon name="repeat" size={11} />}
        {titleOf(event)}
        {compact && <span className="cal-event-inline-time">, {time}</span>}
      </span>
      {!compact && <span className="cal-event-time">{time}</span>}
      {!compact && event.location && height > 56 && (
        <span className="cal-event-location">{event.location}</span>
      )}
      {!segment.endsAfter && (
        <span
          className="cal-event-resize"
          aria-hidden="true"
          onPointerDown={onResize}
        />
      )}
    </button>
  );
}

function EventChip({
  event,
  colors,
  variant,
  selected,
  dragging,
  className = "",
  style,
  onOpen,
  onPointerDown,
}: {
  event: CalendarEvent;
  colors: Colors;
  variant: "bar" | "dot";
  selected?: boolean;
  dragging?: boolean;
  className?: string;
  style?: React.CSSProperties;
  onOpen: (event: CalendarEvent, element: HTMLElement) => void;
  onPointerDown?: (down: ReactPointerEvent<HTMLElement>) => void;
}) {
  const color = colors(event.calendarId);
  return (
    <button
      type="button"
      className={`cal-event cal-event-${variant} ${selected ? "selected" : ""} ${dragging ? "dragging" : ""} ${className}`}
      style={{
        ...style,
        ...(variant === "bar"
          ? { background: color.background, color: color.color }
          : {}),
      }}
      aria-label={eventLabel(event, color.name)}
      onClick={(click) => onOpen(event, click.currentTarget)}
      onPointerDown={onPointerDown}
      onContextMenu={(menu) => menu.preventDefault()}
    >
      {variant === "dot" && (
        <span
          className="cal-dot"
          style={{ background: color.background }}
          aria-hidden="true"
        />
      )}
      {variant === "dot" && (
        <span className="cal-event-time">{formatTime(eventStart(event))}</span>
      )}
      <span className="cal-event-title">
        {event.recurrence !== "none" && variant === "bar" && (
          <Icon name="repeat" size={11} />
        )}
        {titleOf(event)}
      </span>
    </button>
  );
}

function MonthView({
  days,
  events,
  colors,
  now,
  draft,
  selectedId,
  loading,
  blockCreate,
  onCreate,
  onOpen,
  onChange,
  onPickDay,
  onMore,
  month,
}: ViewProps & { month: number }) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const [capacity, setCapacity] = useState(4);
  const [drag, setDrag] = useState<GridDrag | null>(null);
  const guard = useClickGuard();
  const shown = withTiming(events, dragOverride(drag));
  useLayoutEffect(() => {
    const element = bodyRef.current;
    if (!element) return undefined;
    const observer = new ResizeObserver(() => {
      const row = element.clientHeight / 6;
      setCapacity(Math.max(1, Math.floor((row - 30) / 24)));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const weeks = Array.from({ length: 6 }, (_, index) =>
    days.slice(index * 7, index * 7 + 7),
  );
  const first = days[0] ?? startOfDay(now);

  function startDrag(
    down: ReactPointerEvent<HTMLElement>,
    event: CalendarEvent,
  ) {
    if (down.button !== 0) return;
    const grab = cellAt(bodyRef.current, down.clientX, down.clientY, 7, 6);
    if (grab === null) return;
    let timing: EventTiming | null = null;
    trackPointer(down, {
      move: (pointer) => {
        const cell = cellAt(
          bodyRef.current,
          pointer.clientX,
          pointer.clientY,
          7,
          6,
        );
        if (cell === null) return;
        timing = shiftDays(event, cell - grab);
        setDrag({ mode: "move", event, timing });
      },
      end: (_pointer, dragged) => {
        setDrag(null);
        if (!dragged) return;
        guard.arm();
        if (timing && timing.start !== event.start) onChange(event, timing);
      },
      cancel: () => setDrag(null),
    });
  }
  function open(event: CalendarEvent, element: HTMLElement) {
    if (guard.blocked()) return;
    onOpen(event, element.getBoundingClientRect());
  }

  return (
    <div className="cal-month">
      <div className="cal-month-weekdays" aria-hidden="true">
        {days.slice(0, 7).map((day) => (
          <span key={day.getDay()}>
            {day.toLocaleDateString(undefined, { weekday: "short" })}
          </span>
        ))}
      </div>
      <div className="cal-month-body" ref={bodyRef}>
        {weeks.map((week) => {
          const start = week[0] ?? first;
          const { items, lanes } = spanLanes(shown, start, 7);
          const visibleLanes = lanes > capacity ? capacity - 1 : lanes;
          const hidden = hiddenCounts(items, 7, visibleLanes);
          const draftItem = draft
            ? spanLanes([draft], start, 7).items[0]
            : undefined;
          return (
            <div
              key={dayKey(start)}
              className="cal-month-week"
              style={{
                gridTemplateRows: `30px repeat(${Math.max(1, capacity)}, 24px) minmax(0, 1fr)`,
              }}
            >
              {week.map((day, index) => {
                const today = sameDay(day, now);
                const label = day.toLocaleDateString(undefined, {
                  weekday: "long",
                  day: "numeric",
                  month: "long",
                });
                return (
                  <div
                    key={dayKey(day)}
                    className="cal-month-cell"
                    data-outside={day.getMonth() !== month || undefined}
                    data-today={today || undefined}
                    style={{ gridColumn: index + 1, gridRow: "1 / -1" }}
                    onPointerDown={(down) => {
                      if (blockCreate()) return;
                      onTap(down, (element) =>
                        onCreate(
                          day,
                          addDays(day, 1),
                          true,
                          element.getBoundingClientRect(),
                        ),
                      );
                    }}
                  >
                    <button
                      type="button"
                      className="cal-month-day"
                      aria-label={`${label}${today ? ", today" : ""}. Open day view`}
                      aria-current={today ? "date" : undefined}
                      onClick={(click) => {
                        click.stopPropagation();
                        onPickDay(day);
                      }}
                    >
                      {day.getDate() === 1
                        ? day.toLocaleDateString(undefined, {
                            day: "numeric",
                            month: "short",
                          })
                        : day.getDate()}
                    </button>
                    {loading && index % 3 === 1 && (
                      <span
                        className="cal-skeleton cal-skeleton-bar"
                        aria-hidden="true"
                      />
                    )}
                  </div>
                );
              })}
              {items
                .filter((item) => item.lane < visibleLanes)
                .map((item) => (
                  <EventChip
                    key={item.event.id}
                    event={item.event}
                    colors={colors}
                    variant={isSpanning(item.event) ? "bar" : "dot"}
                    selected={selectedId === item.event.id}
                    dragging={
                      drag?.mode === "move" && drag.event.id === item.event.id
                    }
                    className={`${item.startsBefore ? "cut-start" : ""} ${item.endsAfter ? "cut-end" : ""}`}
                    style={{
                      gridColumn: `${item.startColumn + 1} / ${item.endColumn + 1}`,
                      gridRow: item.lane + 2,
                    }}
                    onOpen={open}
                    onPointerDown={(down) => startDrag(down, item.event)}
                  />
                ))}
              {hidden.map((count, index) => {
                const day = week[index];
                return count > 0 && day ? (
                  <button
                    key={dayKey(day)}
                    type="button"
                    className="cal-more"
                    style={{ gridColumn: index + 1, gridRow: visibleLanes + 2 }}
                    aria-label={`${count} more events`}
                    onClick={(click) =>
                      onMore(day, click.currentTarget.getBoundingClientRect())
                    }
                  >
                    +{count}
                    <span className="cal-more-word"> more</span>
                  </button>
                ) : null;
              })}
              {draftItem && (
                <div
                  className="cal-event cal-event-bar cal-draft"
                  aria-hidden="true"
                  style={{
                    gridColumn: `${draftItem.startColumn + 1} / ${draftItem.endColumn + 1}`,
                    gridRow: Math.min(visibleLanes, capacity - 1) + 2,
                  }}
                >
                  <span className="cal-event-title">
                    {draft?.title || "(No title)"}
                  </span>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function MiniMonth({
  anchor,
  range,
  monthOnly,
  today,
  firstDay,
  onPick,
}: {
  anchor: Date;
  range: DateRange;
  monthOnly: boolean;
  today: Date;
  firstDay: number;
  onPick: (day: Date) => void;
}) {
  const [month, setMonth] = useState(
    () => new Date(anchor.getFullYear(), anchor.getMonth(), 1),
  );
  const days = rangeDays(viewRange("month", month, firstDay));
  const title = month.toLocaleDateString(undefined, {
    month: "long",
    year: "numeric",
  });
  return (
    <div className="cal-mini">
      <div className="cal-mini-head">
        <span className="cal-mini-title" aria-live="polite">
          {title}
        </span>
        <button
          type="button"
          aria-label="Previous month"
          onClick={() =>
            setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))
          }
        >
          <Icon name="chevronLeft" size={16} />
        </button>
        <button
          type="button"
          aria-label="Next month"
          onClick={() =>
            setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))
          }
        >
          <Icon name="chevronRight" size={16} />
        </button>
      </div>
      <div className="cal-mini-grid">
        {days.slice(0, 7).map((day) => (
          <span
            key={`w${day.getDay()}`}
            className="cal-mini-weekday"
            aria-hidden="true"
          >
            {day.toLocaleDateString(undefined, { weekday: "narrow" })}
          </span>
        ))}
        {days.map((day) => {
          const selected =
            day >= range.start &&
            day < range.end &&
            (!monthOnly || day.getMonth() === anchor.getMonth());
          const isToday = sameDay(day, today);
          return (
            <button
              key={dayKey(day)}
              type="button"
              data-nav
              className="cal-mini-day"
              data-outside={day.getMonth() !== month.getMonth() || undefined}
              data-selected={selected || undefined}
              data-today={isToday || undefined}
              aria-current={isToday ? "date" : undefined}
              aria-pressed={sameDay(day, anchor)}
              aria-label={day.toLocaleDateString(undefined, {
                weekday: "long",
                day: "numeric",
                month: "long",
                year: "numeric",
              })}
              onClick={() => onPick(day)}
            >
              {day.getDate()}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function CalendarToggle({
  calendar,
  shown,
  onToggle,
}: {
  calendar: Calendar;
  shown: boolean;
  onToggle: () => void;
}) {
  return (
    <li>
      <label className="cal-list-item">
        <input
          type="checkbox"
          className="cal-list-input"
          checked={shown}
          onChange={onToggle}
        />
        <span
          className="cal-list-box"
          aria-hidden="true"
          style={{
            borderColor: calendar.color,
            background: shown ? calendar.color : "transparent",
            color: textColorFor(calendar.color),
          }}
        >
          {shown && <Icon name="check" size={12} strokeWidth={3} />}
        </span>
        <span className="cal-list-name">{calendar.name}</span>
      </label>
    </li>
  );
}

/** Non-modal popover anchored beside a rectangle; a bottom sheet on phones. */
function Popover({
  rect,
  labelledBy,
  onClose,
  className = "",
  children,
}: {
  rect: DOMRect;
  labelledBy: string;
  onClose: () => void;
  className?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [position, setPosition] = useState<{
    left: number;
    top: number;
  } | null>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const gap = 8;
    const width = element.offsetWidth;
    const height = element.offsetHeight;
    const maxLeft = window.innerWidth - width - gap;
    const maxTop = window.innerHeight - height - gap;
    let left = rect.right + gap;
    let top = rect.top;
    if (left > maxLeft) left = rect.left - width - gap;
    if (left < gap) {
      left = clamp(rect.left + rect.width / 2 - width / 2, gap, maxLeft);
      top =
        rect.bottom + gap > maxTop
          ? rect.top - height - gap
          : rect.bottom + gap;
    }
    setPosition({ left, top: clamp(top, gap, Math.max(gap, maxTop)) });
  }, [rect]);
  const [opener] = useState(() => document.activeElement);
  const placed = position !== null;
  useEffect(() => {
    if (!placed) return;
    const element = ref.current;
    const target =
      element?.querySelector<HTMLElement>("[data-autofocus]") ?? element;
    target?.focus();
  }, [placed]);
  useEffect(
    () => () => {
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    },
    [opener],
  );
  useEffect(() => {
    function down(event: PointerEvent) {
      if (event.target instanceof Node && ref.current?.contains(event.target))
        return;
      onClose();
    }
    function key(event: KeyboardEvent) {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      onClose();
    }
    document.addEventListener("pointerdown", down);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", down);
      document.removeEventListener("keydown", key);
    };
  }, [onClose]);
  return (
    <dialog
      ref={ref}
      open
      aria-labelledby={labelledBy}
      tabIndex={-1}
      className={`cal-popover ${className}`}
      style={position ?? { left: 0, top: 0, visibility: "hidden" }}
    >
      {children}
    </dialog>
  );
}

function EventDetails({
  event,
  rect,
  colors,
  onClose,
  onEdit,
  onDelete,
}: {
  event: CalendarEvent;
  rect: DOMRect;
  colors: Colors;
  onClose: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const titleId = useId();
  const color = colors(event.calendarId);
  return (
    <Popover
      rect={rect}
      labelledBy={titleId}
      onClose={onClose}
      className="cal-details"
    >
      <div className="cal-popover-tools">
        <button
          type="button"
          className="cal-icon-button"
          aria-label="Edit event"
          title="Edit"
          data-autofocus
          onClick={onEdit}
        >
          <Icon name="edit" />
        </button>
        <button
          type="button"
          className="cal-icon-button"
          aria-label={
            event.recurrence === "none"
              ? "Delete event"
              : "Delete all occurrences"
          }
          title="Delete"
          onClick={onDelete}
        >
          <Icon name="trash" />
        </button>
        <button
          type="button"
          className="cal-icon-button"
          aria-label="Close"
          title="Close"
          onClick={onClose}
        >
          <Icon name="close" />
        </button>
      </div>
      <div className="cal-details-title">
        <span
          className="cal-swatch"
          style={{ background: color.background }}
          aria-hidden="true"
        />
        <div>
          <h2 id={titleId}>{titleOf(event)}</h2>
          <p>{formatEventRange(event)}</p>
        </div>
      </div>
      <dl className="cal-details-list">
        {event.recurrence !== "none" && (
          <div>
            <dt>
              <Icon name="repeat" label="Repeats" />
            </dt>
            <dd>{recurrenceLabels[event.recurrence]}</dd>
          </div>
        )}
        {event.location && (
          <div>
            <dt>
              <Icon name="pin" label="Location" />
            </dt>
            <dd>{event.location}</dd>
          </div>
        )}
        {event.description && (
          <div>
            <dt>
              <Icon name="text" label="Description" />
            </dt>
            <dd className="cal-details-description">{event.description}</dd>
          </div>
        )}
        <div>
          <dt>
            <Icon name="calendar" label="Calendar" />
          </dt>
          <dd>{color.name}</dd>
        </div>
      </dl>
    </Popover>
  );
}

function QuickCreate({
  content,
  rect,
  calendars,
  onClose,
  onSave,
  onMore,
}: {
  content: EventContent;
  rect: DOMRect;
  calendars: Calendar[];
  onClose: () => void;
  onSave: (content: EventContent) => void;
  onMore: (content: EventContent) => void;
}) {
  const titleId = useId();
  const [title, setTitle] = useState("");
  const [calendarId, setCalendarId] = useState(content.calendarId);
  const current = { ...content, title: title.trim(), calendarId };
  return (
    <Popover
      rect={rect}
      labelledBy={titleId}
      onClose={onClose}
      className="cal-quick"
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          onSave(current);
        }}
      >
        <div className="cal-popover-tools">
          <h2 id={titleId} className="cal-quick-heading">
            New event
          </h2>
          <button
            type="button"
            className="cal-icon-button"
            aria-label="Close"
            onClick={onClose}
          >
            <Icon name="close" />
          </button>
        </div>
        <input
          data-autofocus
          className="cal-quick-title"
          aria-label="Title"
          placeholder="Add title"
          value={title}
          maxLength={500}
          onChange={(event) => setTitle(event.target.value)}
        />
        <p className="cal-quick-when">
          <Icon name="clock" />
          <span>{formatEventRange(content)}</span>
        </p>
        <label className="cal-quick-calendar">
          <Icon name="calendar" />
          <span className="visually-hidden">Calendar</span>
          <select
            className="field-input"
            value={calendarId}
            onChange={(event) => setCalendarId(event.target.value)}
          >
            {calendars.map((calendar) => (
              <option key={calendar.id} value={calendar.id}>
                {calendar.name}
              </option>
            ))}
          </select>
        </label>
        <div className="cal-quick-actions">
          <Button
            type="button"
            variant="ghost"
            size="small"
            onClick={() => onMore(current)}
          >
            More options
          </Button>
          <Button type="submit" size="small" disabled={!calendarId}>
            Save
          </Button>
        </div>
      </form>
    </Popover>
  );
}

function DayPopover({
  day,
  rect,
  events,
  colors,
  onClose,
  onPickDay,
  onOpen,
}: {
  day: Date;
  rect: DOMRect;
  events: CalendarEvent[];
  colors: Colors;
  onClose: () => void;
  onPickDay: (day: Date) => void;
  onOpen: (event: CalendarEvent, rect: DOMRect) => void;
}) {
  const titleId = useId();
  const list = events
    .filter((event) =>
      overlapsRange(event, { start: day, end: addDays(day, 1) }),
    )
    .toSorted(
      (a, b) =>
        Number(isSpanning(b)) - Number(isSpanning(a)) ||
        eventStart(a).getTime() - eventStart(b).getTime(),
    );
  return (
    <Popover
      rect={rect}
      labelledBy={titleId}
      onClose={onClose}
      className="cal-daylist"
    >
      <div className="cal-popover-tools">
        <h2 id={titleId}>
          <button
            type="button"
            className="cal-link"
            onClick={() => onPickDay(day)}
          >
            {day.toLocaleDateString(undefined, {
              weekday: "long",
              day: "numeric",
              month: "long",
            })}
          </button>
        </h2>
        <button
          type="button"
          className="cal-icon-button"
          aria-label="Close"
          data-autofocus
          onClick={onClose}
        >
          <Icon name="close" />
        </button>
      </div>
      <ul>
        {list.map((event) => (
          <li key={event.id}>
            <EventChip
              event={event}
              colors={colors}
              variant={isSpanning(event) ? "bar" : "dot"}
              onOpen={(item, element) =>
                onOpen(item, element.getBoundingClientRect())
              }
            />
          </li>
        ))}
      </ul>
    </Popover>
  );
}

function EventEditor({
  content,
  calendars,
  onCancel,
  onSave,
}: {
  content: EventContent;
  calendars: Calendar[];
  onCancel: () => void;
  onSave: (content: EventContent) => void;
}) {
  const id = useId();
  const [form, setForm] = useState<EventForm>(() => formFromEvent(content));
  const [error, setError] = useState("");
  const formRef = useRef<HTMLFormElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    titleRef.current?.focus();
    const element = formRef.current;
    function key(event: KeyboardEvent) {
      if (event.key !== "Enter" || !(event.ctrlKey || event.metaKey)) return;
      event.preventDefault();
      element?.requestSubmit();
    }
    element?.addEventListener("keydown", key);
    return () => element?.removeEventListener("keydown", key);
  }, []);
  const update = (change: Partial<EventForm>) => {
    setForm((current) => ({ ...current, ...change }));
    setError("");
  };
  function submit(event: FormEvent) {
    event.preventDefault();
    const timing = timingFromForm(form);
    if ("error" in timing) {
      setError(timing.error);
      return;
    }
    onSave({
      ...content,
      title: form.title.trim(),
      allDay: form.allDay,
      recurrence: form.recurrence,
      calendarId: form.calendarId,
      location: form.location.trim(),
      description: form.description,
      // Keep the event's own zone: a different zone moves the series and
      // drops its exceptions. All-day events have none, so a timed version
      // uses this browser's zone.
      timeZone: content.allDay && !form.allDay ? timeZone : content.timeZone,
      ...timing,
    });
  }
  const errorId = `${id}-error`;
  const invalid = error !== "";
  return (
    <form className="cal-editor" ref={formRef} onSubmit={submit}>
      <TextField
        ref={titleRef}
        label="Title"
        placeholder="Add title"
        maxLength={500}
        value={form.title}
        onChange={(event) => update({ title: event.target.value })}
      />
      <label className="cal-checkbox">
        <input
          type="checkbox"
          checked={form.allDay}
          onChange={(event) => {
            const allDay = event.target.checked;
            // A former all-day event gets a one-hour slot instead of 00:00.
            const untimed =
              !allDay && form.startTime === "00:00" && form.endTime === "00:00";
            update({
              allDay,
              ...(untimed
                ? {
                    startTime: "09:00",
                    endTime: "10:00",
                    endDate: form.startDate,
                  }
                : {}),
            });
          }}
        />
        All day
      </label>
      <fieldset className="cal-editor-when">
        <legend className="visually-hidden">Date and time</legend>
        <div className="cal-editor-pair">
          <label className="field">
            <span className="field-label">Start date</span>
            <input
              type="date"
              className="field-input"
              required
              value={form.startDate}
              onChange={(event) =>
                setForm((current) =>
                  shiftFormStart(
                    current,
                    event.target.value,
                    current.startTime,
                  ),
                )
              }
            />
          </label>
          {!form.allDay && (
            <label className="field">
              <span className="field-label">Start time</span>
              <input
                type="time"
                className="field-input"
                required
                step={300}
                value={form.startTime}
                onChange={(event) =>
                  setForm((current) =>
                    shiftFormStart(
                      current,
                      current.startDate,
                      event.target.value,
                    ),
                  )
                }
              />
            </label>
          )}
        </div>
        <div className="cal-editor-pair">
          <label className="field">
            <span className="field-label">End date</span>
            <input
              type="date"
              className="field-input"
              required
              aria-invalid={invalid}
              aria-describedby={invalid ? errorId : undefined}
              value={form.endDate}
              onChange={(event) => update({ endDate: event.target.value })}
            />
          </label>
          {!form.allDay && (
            <label className="field">
              <span className="field-label">End time</span>
              <input
                type="time"
                className="field-input"
                required
                step={300}
                aria-invalid={invalid}
                aria-describedby={invalid ? errorId : undefined}
                value={form.endTime}
                onChange={(event) => update({ endTime: event.target.value })}
              />
            </label>
          )}
        </div>
        {invalid && (
          <p className="field-error" id={errorId} role="alert">
            {error}
          </p>
        )}
      </fieldset>
      <div className="cal-editor-pair">
        <label className="field">
          <span className="field-label">Repeat</span>
          <select
            className="field-input"
            value={form.recurrence}
            onChange={(event) => {
              const recurrence = RecurrenceSchema.safeParse(event.target.value);
              if (recurrence.success) update({ recurrence: recurrence.data });
            }}
          >
            {Object.entries(recurrenceLabels).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="field-label">Calendar</span>
          <select
            className="field-input"
            value={form.calendarId}
            onChange={(event) => update({ calendarId: event.target.value })}
          >
            {calendars.map((calendar) => (
              <option key={calendar.id} value={calendar.id}>
                {calendar.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <TextField
        label="Location"
        maxLength={500}
        value={form.location}
        onChange={(event) => update({ location: event.target.value })}
      />
      <label className="field">
        <span className="field-label">Description</span>
        <textarea
          className="field-input cal-editor-description"
          rows={3}
          maxLength={20_000}
          value={form.description}
          onChange={(event) => update({ description: event.target.value })}
        />
      </label>
      <div className="dialog-actions cal-dialog-actions">
        <span className="cal-editor-hint">
          <kbd>Ctrl</kbd> + <kbd>Enter</kbd> to save
        </span>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={!form.calendarId}>
          Save
        </Button>
      </div>
    </form>
  );
}

function NewCalendarForm({
  busy,
  error,
  onCreate,
}: {
  busy: boolean;
  error: string;
  onCreate: (input: { name: string; color: string }) => void;
}) {
  const [name, setName] = useState("");
  const [color, setColor] = useState(calendarPalette[0]?.color ?? "#6d4bd8");
  const [invalid, setInvalid] = useState("");
  const nameRef = useRef<HTMLInputElement>(null);
  useEffect(() => nameRef.current?.focus(), []);
  return (
    <form
      className="cal-editor"
      onSubmit={(event) => {
        event.preventDefault();
        if (!name.trim()) {
          setInvalid("Enter a calendar name.");
          return;
        }
        onCreate({ name: name.trim(), color });
      }}
    >
      <TextField
        ref={nameRef}
        label="Name"
        maxLength={100}
        value={name}
        error={invalid || error}
        onChange={(event) => {
          setName(event.target.value);
          setInvalid("");
        }}
      />
      <fieldset className="cal-palette">
        <legend className="field-label">Color</legend>
        {calendarPalette.map((item) => (
          <label
            key={item.color}
            className="cal-palette-item"
            title={item.name}
          >
            <input
              type="radio"
              name="calendar-color"
              value={item.color}
              checked={color === item.color}
              onChange={() => setColor(item.color)}
            />
            <span
              style={{
                background: item.color,
                color: textColorFor(item.color),
              }}
              aria-hidden="true"
            >
              {color === item.color && (
                <Icon name="check" size={14} strokeWidth={3} />
              )}
            </span>
            <span className="visually-hidden">{item.name}</span>
          </label>
        ))}
      </fieldset>
      <div className="dialog-actions">
        <Button type="submit" disabled={busy}>
          {busy ? "Creating…" : "Create calendar"}
        </Button>
      </div>
    </form>
  );
}
