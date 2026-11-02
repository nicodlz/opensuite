import * as React from "react";
import type {
  Calendar,
  CalendarEvent,
  EventContent,
  Reminder,
} from "@opensuite/contracts";
import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type RefObject,
} from "react";
import { Button } from "../ui/button.tsx";
import { TextField } from "../ui/text-field.tsx";
import {
  CalendarSelect,
  ReminderField,
  RepeatField,
  WhenFields,
  type Update,
} from "./editor-fields.tsx";
import { GuestsField, invitationFor, saveBlock, useGuests } from "./guests.tsx";
import { formFromEvent, timingFromForm, type EventForm } from "./model.ts";
import type { InvitationRequest } from "./organizer-model.ts";

const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

/** Focuses the title and saves on Ctrl or Cmd + Enter. */
function useEditorKeys(
  formRef: RefObject<HTMLFormElement | null>,
  titleRef: RefObject<HTMLInputElement | null>,
) {
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
  }, [formRef, titleRef]);
}

function EditorActions({
  block,
  disabled,
  onCancel,
}: {
  block: string;
  disabled: boolean;
  onCancel: () => void;
}) {
  return (
    <div className="dialog-actions cal-dialog-actions">
      {block ? (
        <output className="cal-editor-block">{block}</output>
      ) : (
        <span className="cal-editor-hint">
          <kbd>Ctrl</kbd> + <kbd>Enter</kbd> to save
        </span>
      )}
      <Button type="button" variant="ghost" onClick={onCancel}>
        Cancel
      </Button>
      <Button type="submit" disabled={disabled || block !== ""}>
        Save
      </Button>
    </div>
  );
}

/** The event as edited, keeping what the form does not show. */
function editedContent(
  content: EventContent,
  form: EventForm,
  reminder: Reminder,
  calendarId: string,
) {
  const timing = timingFromForm(form);
  if ("error" in timing) return timing;
  return {
    ...content,
    title: form.title.trim(),
    allDay: form.allDay,
    recurrence: form.recurrence,
    reminder,
    calendarId,
    location: form.location.trim(),
    description: form.description,
    // Keep the event's own zone: a different zone moves the series and
    // drops its exceptions. All-day events have none, so a timed version
    // uses this browser's zone.
    timeZone: content.allDay && !form.allDay ? timeZone : content.timeZone,
    ...timing,
  };
}

function useEditorForm(content: EventContent) {
  const [form, setForm] = useState<EventForm>(() => formFromEvent(content));
  const [reminder, setReminder] = useState<Reminder>(
    content.reminder ?? "none",
  );
  const [error, setError] = useState("");
  const update: Update = (change) => {
    setForm((current) => ({ ...current, ...change }));
    setError("");
  };
  return { form, setForm, update, reminder, setReminder, error, setError };
}

function DetailFields({ form, update }: { form: EventForm; update: Update }) {
  return (
    <>
      <TextField
        label="Location"
        maxLength={500}
        value={form.location}
        onChange={(change) => update({ location: change.target.value })}
      />
      <label className="field">
        <span className="field-label">Description</span>
        <textarea
          className="field-input cal-editor-description"
          rows={3}
          maxLength={20_000}
          value={form.description}
          onChange={(change) => update({ description: change.target.value })}
        />
      </label>
    </>
  );
}

/**
 * The full event form. A change that notifies guests goes to `onInvite` for
 * confirmation; any other change to `onSave`.
 */
export function EventEditor({
  content,
  event,
  calendars,
  fallbackCalendarId,
  onCancel,
  onSave,
  onInvite,
}: {
  content: EventContent;
  /** The event being edited; none for a new one. */
  event?: CalendarEvent | undefined;
  calendars: Calendar[];
  /** Used while no calendar was chosen, e.g. when calendars load late. */
  fallbackCalendarId: string;
  onCancel: () => void;
  onSave: (content: EventContent) => void;
  onInvite: (request: InvitationRequest) => void;
}) {
  const { form, setForm, update, reminder, setReminder, error, setError } =
    useEditorForm(content);
  const guests = useGuests(event);
  const calendarId = form.calendarId || fallbackCalendarId;
  const formRef = useRef<HTMLFormElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  useEditorKeys(formRef, titleRef);
  const withGuests =
    guests.mode === "new" ? guests.list.length > 0 : guests.mode !== "plain";
  const block = saveBlock(guests);
  function submit(submitted: FormEvent) {
    submitted.preventDefault();
    // Ctrl + Enter submits even while Save is disabled.
    if (block || !calendarId) return;
    const next = editedContent(content, form, reminder, calendarId);
    if ("error" in next) {
      setError(next.error);
      return;
    }
    const invitation = invitationFor(guests, event, content, next);
    if (invitation === "plain") onSave(next);
    else if (invitation === "unchanged") onCancel();
    else onInvite(invitation);
  }
  return (
    <form className="cal-editor" ref={formRef} onSubmit={submit}>
      <TextField
        ref={titleRef}
        label="Title"
        placeholder="Add title"
        maxLength={500}
        value={form.title}
        onChange={(change) => update({ title: change.target.value })}
      />
      <WhenFields form={form} setForm={setForm} update={update} error={error} />
      <div className="cal-editor-pair">
        <RepeatField form={form} update={update} />
        <CalendarSelect
          className="field"
          calendars={calendars}
          value={calendarId}
          disabled={guests.mode !== "new" && withGuests}
          onChange={(picked) => update({ calendarId: picked })}
        >
          <span className="field-label">Calendar</span>
        </CalendarSelect>
      </div>
      <ReminderField
        value={reminder}
        custom={content.reminder === "custom"}
        locked={withGuests}
        onChange={setReminder}
      />
      <DetailFields form={form} update={update} />
      <GuestsField guests={guests} />
      <EditorActions block={block} disabled={!calendarId} onCancel={onCancel} />
    </form>
  );
}
