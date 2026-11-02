import { createdItem, updatedItem, destroyedItem } from "./set-results.ts";
import { validatePageResponses } from "./page-response.ts";
import { err, ok } from "neverthrow";
import { z } from "zod";
import { type JmapResult, type Session } from "./protocol.ts";
import { MailWriteClient } from "./mail-write.ts";
import {
  CalendarSchema,
  CalendarEventSchema,
  GetSchema,
  QuerySchema,
  SetSchema,
  usingCalendars,
  type CalendarEvent,
} from "./schemas.ts";

export class CalendarClient extends MailWriteClient {
  calendars(session: Session, accountId: string) {
    return this.transport.call(
      session.apiUrl,
      "Calendar/get",
      { accountId },
      usingCalendars,
      GetSchema(CalendarSchema),
    );
  }
  async createCalendar(
    session: Session,
    accountId: string,
    calendar: { name: string; color: string },
    isDefault = false,
  ): Promise<JmapResult<{ id: string }>> {
    // Stalwart rejects `isDefault` as a created property; the default is set
    // with the RFC `onSuccessSetIsDefault` argument instead.
    const method = "Calendar/set";
    const result = await this.transport.call(
      session.apiUrl,
      method,
      {
        accountId,
        create: { item: calendar },
        ...(isDefault ? { onSuccessSetIsDefault: "#item" } : {}),
      },
      usingCalendars,
      SetSchema(z.object({ id: z.string() })),
    );
    return createdItem(method, result);
  }
  /** One page of event ids and their full objects, in a single request. */
  async calendarEventPage(
    session: Session,
    accountId: string,
    options: { filter: object; position: number; limit: number },
  ): Promise<
    JmapResult<{
      query: z.infer<typeof QuerySchema>;
      events: { state: string; list: CalendarEvent[]; notFound: string[] };
    }>
  > {
    const result = await this.transport.json(
      session.apiUrl,
      z.object({
        methodResponses: z.array(
          z.tuple([z.string(), z.unknown(), z.string()]),
        ),
        sessionState: z.string(),
      }),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          using: usingCalendars,
          methodCalls: [
            ["CalendarEvent/query", { accountId, ...options }, "query"],
            [
              // Full objects: see `calendarEvents`.
              "CalendarEvent/get",
              {
                accountId,
                "#ids": {
                  resultOf: "query",
                  name: "CalendarEvent/query",
                  path: "/ids",
                },
              },
              "events",
            ],
          ],
        }),
      },
    );
    if (result.isErr()) return err(result.error);
    const calls = result.value.methodResponses;
    const expected = [
      ["CalendarEvent/query", "query"],
      ["CalendarEvent/get", "events"],
    ];
    const validated = validatePageResponses(calls, expected);
    if (validated.isErr()) return err(validated.error);
    const query = QuerySchema.safeParse(calls[0]?.[1]);
    const events = GetSchema(CalendarEventSchema).safeParse(calls[1]?.[1]);
    if (!query.success || !events.success)
      return err({
        kind: "invalidResponse",
        message: "Invalid calendar event page response",
      });
    return ok({ query: query.data, events: events.data });
  }
  calendarEvents(session: Session, accountId: string, ids: readonly string[]) {
    // Stalwart v1.0.1 omits `recurrenceRules` when it is listed in
    // `properties`, so full objects are requested.
    return this.transport.call(
      session.apiUrl,
      "CalendarEvent/get",
      { accountId, ids },
      usingCalendars,
      GetSchema(CalendarEventSchema),
    );
  }
  async createCalendarEvent(
    session: Session,
    accountId: string,
    event: object,
    ifInState?: string,
  ): Promise<JmapResult<{ id: string }>> {
    const method = "CalendarEvent/set";
    const result = await this.transport.call(
      session.apiUrl,
      method,
      { accountId, create: { item: event }, ifInState },
      usingCalendars,
      SetSchema(z.object({ id: z.string() })),
    );
    return createdItem(method, result);
  }
  async updateCalendarEvent(
    session: Session,
    accountId: string,
    id: string,
    patch: Record<string, unknown>,
    ifInState?: string,
  ): Promise<JmapResult<void>> {
    const method = "CalendarEvent/set";
    const result = await this.transport.call(
      session.apiUrl,
      method,
      { accountId, update: { [id]: patch }, ifInState },
      usingCalendars,
      SetSchema(z.unknown()),
    );
    return updatedItem(method, result, id);
  }
  async destroyCalendarEvent(
    session: Session,
    accountId: string,
    id: string,
  ): Promise<JmapResult<void>> {
    const method = "CalendarEvent/set";
    const result = await this.transport.call(
      session.apiUrl,
      method,
      { accountId, destroy: [id] },
      usingCalendars,
      SetSchema(z.unknown()),
    );
    return destroyedItem(method, result, id);
  }
}
