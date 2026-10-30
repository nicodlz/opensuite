import { oc } from "@orpc/contract";
import { z } from "zod";
import { IdSchema } from "./mail.ts";

// Timed events use UTC instants. All-day events use UTC midnight and only the
// date part is meaningful; `end` is exclusive in both cases.
export const CalendarSchema = z.object({
  id: IdSchema,
  name: z.string(),
  color: z.string().regex(/^#[0-9a-f]{6}$/i),
  isDefault: z.boolean(),
});
export const RecurrenceSchema = z.enum([
  "none",
  "daily",
  "weekly",
  "monthly",
  "yearly",
]);
// "custom" represents alarms that the simple picker must preserve unchanged.
export const ReminderSchema = z.enum([
  "none",
  "at-time",
  "5m",
  "10m",
  "15m",
  "30m",
  "1h",
  "1d",
  "custom",
]);
export const EventContentSchema = z.object({
  calendarId: IdSchema,
  title: z.string().max(500),
  description: z.string().max(20_000),
  location: z.string().max(500),
  start: z.iso.datetime(),
  end: z.iso.datetime(),
  allDay: z.boolean(),
  timeZone: z.string().min(1),
  recurrence: RecurrenceSchema,
  reminder: ReminderSchema.optional(),
});
// `id` identifies one occurrence; `seriesId` the stored event. Updates and
// deletes of a recurring occurrence apply to the whole series.
export const EventSchema = EventContentSchema.extend({
  id: IdSchema,
  seriesId: IdSchema,
});
const AccountSchema = z.object({ accountId: IdSchema });
const EventInputSchema = AccountSchema.extend({ eventId: IdSchema });
const errors = {
  NOT_FOUND: { status: 404, message: "Calendar item not found" },
  FORBIDDEN: { status: 403, message: "Access denied" },
  VALIDATION: { status: 400, message: "Invalid calendar data" },
  CONFLICT: { status: 409, message: "Calendar item changed" },
  UPSTREAM_UNAVAILABLE: {
    status: 503,
    message: "Calendar service unavailable",
  },
};
const procedure = oc.errors(errors);
const ok = z.object({ success: z.literal(true) });

export const calendarContract = {
  calendars: procedure
    .route({ method: "POST", path: "/calendar/calendars" })
    .input(AccountSchema)
    .output(z.object({ calendars: z.array(CalendarSchema) })),
  createCalendar: procedure
    .route({ method: "POST", path: "/calendar/calendars/create" })
    .input(
      AccountSchema.extend({
        name: z.string().trim().min(1).max(100),
        color: CalendarSchema.shape.color,
      }),
    )
    .output(CalendarSchema),
  events: procedure
    .route({ method: "POST", path: "/calendar/events" })
    .input(
      AccountSchema.extend({
        start: z.iso.datetime(),
        end: z.iso.datetime(),
        calendarIds: z.array(IdSchema).optional(),
      }),
    )
    .output(z.object({ events: z.array(EventSchema) })),
  createEvent: procedure
    .route({ method: "POST", path: "/calendar/events/create" })
    .input(AccountSchema.extend({ event: EventContentSchema }))
    .output(EventSchema),
  updateEvent: procedure
    .route({ method: "POST", path: "/calendar/events/update" })
    .input(EventInputSchema.extend({ event: EventContentSchema }))
    .output(EventSchema),
  deleteEvent: procedure
    .route({ method: "POST", path: "/calendar/events/delete" })
    .input(EventInputSchema)
    .output(ok),
};
export type Calendar = z.infer<typeof CalendarSchema>;
export type CalendarEvent = z.infer<typeof EventSchema>;
export type EventContent = z.infer<typeof EventContentSchema>;
export type Recurrence = z.infer<typeof RecurrenceSchema>;
export type Reminder = z.infer<typeof ReminderSchema>;
