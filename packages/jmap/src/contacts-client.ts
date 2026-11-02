import { CalendarClient } from "./calendar-client.ts";
import { ContactsApi } from "./protocol.ts";
import { GetSchema, QuerySchema } from "./schemas.ts";

/** Contact operations use the same user-scoped transport as mail and calendar. */
export class ContactsClient extends CalendarClient {
  readonly contacts = new ContactsApi(this.transport, GetSchema, QuerySchema);
}
