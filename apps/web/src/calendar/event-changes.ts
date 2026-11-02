import type { CalendarEvent, EventContent } from "@opensuite/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { useToast } from "../ui/toast.tsx";
import { accountId, calendarClient } from "./client.ts";
import type { EventFocus } from "./event-focus.ts";
import { eventsKey, isUnavailable, type EventsData } from "./events.ts";
import {
  applyEventChange,
  formatEventRange,
  formatTime,
  isPending,
  isRecurring,
  type EventChange,
  type EventTiming,
} from "./model.ts";

type Outcome = "create" | "save" | "move" | "delete" | "undo";
type Run = (
  change: EventChange,
  outcome: Outcome,
) => Promise<CalendarEvent | null>;

const verbs: Record<Exclude<Outcome, "undo">, string> = {
  create: "created",
  save: "saved",
  move: "moved",
  delete: "deleted",
};

/** Reported after the optimistic change has been rolled back. */
function failureMessage(outcome: Outcome, error: unknown) {
  const result =
    outcome === "undo"
      ? "The move could not be undone."
      : "Your change was undone.";
  if (isUnavailable(error)) return `Calendar is unavailable. ${result}`;
  if (outcome === "undo") return result;
  return `The event could not be ${verbs[outcome]}. ${result}`;
}

function timingMessage(event: CalendarEvent, timing: EventTiming) {
  const series = isRecurring(event);
  if (!event.allDay && timing.start === event.start) {
    const end = formatTime(new Date(timing.end));
    return series
      ? `All occurrences now end at ${end}`
      : `Event now ends at ${end}`;
  }
  if (series) return "All occurrences moved";
  return `Event moved to ${formatEventRange({ ...timing, allDay: event.allDay })}`;
}

/**
 * The moved occurrence as the server now identifies it. A recurring
 * occurrence's id follows its time, so it is looked up again.
 */
async function movedOccurrence(event: CalendarEvent, timing: EventTiming) {
  if (!isRecurring(event)) return { ...event, ...timing };
  const { events } = await calendarClient.events({
    accountId,
    ...timing,
    calendarIds: [event.calendarId],
  });
  return events.find(
    (item) => item.seriesId === event.seriesId && item.start === timing.start,
  );
}

/** Optimistic create, update and delete, rolled back with a notice on failure. */
function useEventMutation() {
  const queryClient = useQueryClient();
  const { notify } = useToast();
  return useMutation({
    mutationFn: async ({
      change,
    }: {
      change: EventChange;
      outcome: Outcome;
    }): Promise<CalendarEvent | null> => {
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
    onMutate: async ({ change }) => {
      await queryClient.cancelQueries({ queryKey: eventsKey });
      const snapshot = queryClient.getQueriesData<EventsData>({
        queryKey: eventsKey,
      });
      queryClient.setQueriesData<EventsData>({ queryKey: eventsKey }, (data) =>
        data ? { events: applyEventChange(data.events, change) } : data,
      );
      return { snapshot };
    },
    onSuccess: (saved, { change }) => {
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
    onError: (error, { outcome }, context) => {
      for (const [key, data] of context?.snapshot ?? [])
        queryClient.setQueryData(key, data);
      notify({ message: failureMessage(outcome, error) });
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: eventsKey }),
  });
}

/**
 * A deletion is only sent when its notification closes, so Undo just shows
 * the event again and the server keeps what the editor does not display
 * (exceptions, custom alerts, invitations). Leaving Calendar or the page
 * sends waiting deletions at once.
 */
function useDeferredDeletes(run: Run, focus: EventFocus) {
  const { notify } = useToast();
  const [deleting, setDeleting] = useState<ReadonlySet<string>>(new Set());
  const waiting = useRef(new Map<string, () => void>());
  const hide = useCallback((seriesId: string, hidden: boolean) => {
    setDeleting((current) => {
      const next = new Set(current);
      if (hidden) next.add(seriesId);
      else next.delete(seriesId);
      return next;
    });
  }, []);
  useEffect(() => {
    const entries = waiting.current;
    // Each entry removes itself; a Map iterator allows that.
    const flush = () => {
      for (const send of entries.values()) send();
    };
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, []);
  const remove = useCallback(
    (event: CalendarEvent) => {
      if (isPending(event)) return;
      const key = event.seriesId;
      let settled = false;
      const commit = () => {
        if (settled) return;
        settled = true;
        waiting.current.delete(key);
        void run({ type: "delete", event }, "delete").finally(() =>
          hide(key, false),
        );
      };
      const undo = () => {
        settled = true;
        waiting.current.delete(key);
        hide(key, false);
        focus.request({ seriesId: key, start: event.start });
      };
      hide(key, true);
      focus.request({});
      const dismiss = notify({
        message: isRecurring(event)
          ? "All occurrences deleted"
          : "Event deleted",
        action: { label: "Undo", onAction: undo },
        onClose: commit,
      });
      waiting.current.set(key, () => {
        dismiss();
        commit();
      });
    },
    [run, focus, notify, hide],
  );
  return { deleting, remove };
}

/**
 * Calendar changes with their outcome announced in the shared notification
 * region, Undo for moves and deletions, and focus kept on the event.
 * `deleting` holds the series hidden while their deletion can be undone.
 */
export function useEventChanges(focus: EventFocus) {
  const { notify } = useToast();
  const { mutateAsync } = useEventMutation();
  // Failures are reported by the mutation; callers only need the result.
  const run = useCallback<Run>(
    (change, outcome) => mutateAsync({ change, outcome }).catch(() => null),
    [mutateAsync],
  );
  const { deleting, remove } = useDeferredDeletes(run, focus);
  const undoMove = useCallback(
    async (
      event: CalendarEvent,
      content: EventContent,
      timing: EventTiming,
    ) => {
      focus.request({ seriesId: event.seriesId, start: event.start });
      let current: CalendarEvent | undefined;
      try {
        current = await movedOccurrence(event, timing);
      } catch (error) {
        notify({ message: failureMessage("undo", error) });
        return;
      }
      if (current)
        await run({ type: "update", event: current, content }, "undo");
      else notify({ message: failureMessage("undo", null) });
    },
    [focus, notify, run],
  );
  return {
    deleting,
    remove,
    /** Focus waits on the calendar until the server has named the event. */
    async create(content: EventContent) {
      focus.request({ wait: true });
      const id = `draft-${crypto.randomUUID()}`;
      const saved = await run({ type: "create", id, content }, "create");
      if (saved) notify({ message: "Event created" });
      focus.retarget(
        saved ? { seriesId: saved.seriesId, start: saved.start } : {},
      );
      return saved;
    },
    async save(event: CalendarEvent, content: EventContent) {
      focus.request({ seriesId: event.seriesId, start: content.start });
      const saved = await run({ type: "update", event, content }, "save");
      if (saved) notify({ message: "Event saved" });
      return saved;
    },
    /** `content` is the event before the move; Undo restores it. */
    async move(
      event: CalendarEvent,
      content: EventContent,
      timing: EventTiming,
    ) {
      focus.request({ seriesId: event.seriesId, start: timing.start });
      const change: EventChange = {
        type: "update",
        event,
        content: { ...content, ...timing },
      };
      if (!(await run(change, "move"))) return;
      notify({
        message: timingMessage(event, timing),
        action: {
          label: "Undo",
          onAction: () => void undoMove(event, content, timing),
        },
      });
    },
  };
}
