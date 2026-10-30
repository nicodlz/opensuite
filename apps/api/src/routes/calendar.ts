import { contract } from "@opensuite/contracts";
import type { CalendarFailure } from "@opensuite/core/services/calendar";
import { implement, ORPCError } from "@orpc/server";
import type { Result } from "neverthrow";
import type { ApiContext } from "./context.ts";

const calendar = implement(contract.calendar).$context<ApiContext>();
const access = (context: ApiContext) => {
  if (context.actor === null) throw new ORPCError("UNAUTHORIZED");
  if (context.calendar === undefined)
    throw new ORPCError("UPSTREAM_UNAVAILABLE", {
      status: 503,
      defined: true,
      message: "Calendar service unavailable",
    });
  return { actor: context.actor, service: context.calendar };
};
const result = async <T>(
  promise: Promise<Result<T, CalendarFailure>>,
): Promise<T> => {
  const value = await promise;
  if (value.isOk()) return value.value;
  const codes = {
    forbidden: "FORBIDDEN",
    not_found: "NOT_FOUND",
    validation: "VALIDATION",
    conflict: "CONFLICT",
    unavailable: "UPSTREAM_UNAVAILABLE",
  } satisfies Record<CalendarFailure["kind"], string>;
  const statuses = {
    forbidden: 403,
    not_found: 404,
    validation: 400,
    conflict: 409,
    unavailable: 503,
  } satisfies Record<CalendarFailure["kind"], number>;
  throw new ORPCError(codes[value.error.kind], {
    status: statuses[value.error.kind],
    defined: true,
  });
};
export const calendarRouter = calendar.router({
  calendars: calendar.calendars.handler(({ context, input }) => {
    const { actor, service } = access(context);
    return result(service.calendars(actor, input.accountId));
  }),
  createCalendar: calendar.createCalendar.handler(({ context, input }) => {
    const { actor, service } = access(context);
    return result(service.createCalendar(actor, input.accountId, input));
  }),
  events: calendar.events.handler(({ context, input }) => {
    const { actor, service } = access(context);
    return result(service.events(actor, input.accountId, input));
  }),
  createEvent: calendar.createEvent.handler(({ context, input }) => {
    const { actor, service } = access(context);
    return result(service.createEvent(actor, input.accountId, input.event));
  }),
  updateEvent: calendar.updateEvent.handler(({ context, input }) => {
    const { actor, service } = access(context);
    return result(
      service.updateEvent(actor, input.accountId, input.eventId, input.event),
    );
  }),
  deleteEvent: calendar.deleteEvent.handler(({ context, input }) => {
    const { actor, service } = access(context);
    return result(service.deleteEvent(actor, input.accountId, input.eventId));
  }),
});
