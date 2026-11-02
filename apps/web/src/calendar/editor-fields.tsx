import * as React from "react";
import {
  RecurrenceSchema,
  ReminderSchema,
  type Calendar,
  type Reminder,
} from "@opensuite/contracts";
import {
  useId,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";
import { recurrenceLabels, shiftFormStart, type EventForm } from "./model.ts";

export type Update = (change: Partial<EventForm>) => void;
type SetForm = Dispatch<SetStateAction<EventForm>>;

/** A labelled calendar picker; `children` is the label's visible content. */
export function CalendarSelect({
  className,
  children,
  calendars,
  value,
  disabled = false,
  onChange,
}: {
  className: string;
  children: ReactNode;
  calendars: Calendar[];
  value: string;
  disabled?: boolean;
  onChange: (id: string) => void;
}) {
  return (
    <label className={className}>
      {children}
      <select
        className="field-input"
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      >
        {calendars.map((calendar) => (
          <option key={calendar.id} value={calendar.id}>
            {calendar.name}
          </option>
        ))}
      </select>
    </label>
  );
}

function AllDayToggle({ form, update }: { form: EventForm; update: Update }) {
  return (
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
  );
}

function StartFields({ form, setForm }: { form: EventForm; setForm: SetForm }) {
  return (
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
              shiftFormStart(current, event.target.value, current.startTime),
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
                shiftFormStart(current, current.startDate, event.target.value),
              )
            }
          />
        </label>
      )}
    </div>
  );
}

function EndFields({
  form,
  update,
  error,
}: {
  form: EventForm;
  update: Update;
  error: string;
}) {
  const id = useId();
  const errorId = `${id}-error`;
  const invalid = error !== "";
  const described = invalid ? errorId : undefined;
  return (
    <>
      <div className="cal-editor-pair">
        <label className="field">
          <span className="field-label">End date</span>
          <input
            type="date"
            className="field-input"
            required
            aria-invalid={invalid}
            aria-describedby={described}
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
              aria-describedby={described}
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
    </>
  );
}

export function ReminderField({
  value,
  custom,
  locked,
  onChange,
}: {
  value: Reminder;
  custom: boolean;
  locked: boolean;
  onChange: (value: Reminder) => void;
}) {
  return (
    <label className="field">
      <span className="field-label">Reminder</span>
      <select
        className="field-input"
        value={locked ? "none" : value}
        disabled={locked}
        onChange={(event) => {
          const parsed = ReminderSchema.safeParse(event.target.value);
          if (parsed.success) onChange(parsed.data);
        }}
      >
        <option value="none">None</option>
        <option value="at-time">At time of event</option>
        <option value="5m">5 minutes before</option>
        <option value="10m">10 minutes before</option>
        <option value="15m">15 minutes before</option>
        <option value="30m">30 minutes before</option>
        <option value="1h">1 hour before</option>
        <option value="1d">1 day before</option>
        {custom && <option value="custom">Custom reminders</option>}
      </select>
      {locked && (
        <span className="field-description">
          {"Events with guests can't have reminders yet."}
        </span>
      )}
    </label>
  );
}

export function RepeatField({
  form,
  update,
}: {
  form: EventForm;
  update: Update;
}) {
  return (
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
  );
}

/** All day, then the start and the end of the event. */
export function WhenFields({
  form,
  setForm,
  update,
  error,
}: {
  form: EventForm;
  setForm: SetForm;
  update: Update;
  error: string;
}) {
  return (
    <>
      <AllDayToggle form={form} update={update} />
      <fieldset className="cal-editor-when">
        <legend className="visually-hidden">Date and time</legend>
        <StartFields form={form} setForm={setForm} />
        <EndFields form={form} update={update} error={error} />
      </fieldset>
    </>
  );
}
