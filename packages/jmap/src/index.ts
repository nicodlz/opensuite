import { ContactsClient } from "./contacts-client.ts";
import { threadPage } from "./thread-page.ts";

export { JmapCapability } from "./protocol.ts";
export type {
  JmapError,
  JmapResult,
  Session,
  TransportOptions,
} from "./protocol.ts";
export type {
  Mailbox,
  Email,
  Identity,
  Calendar,
  CalendarEvent,
  RecurrenceRule,
} from "./schemas.ts";

/** The authorization value is supplied by the caller; keep user credentials server-side. */
export class JmapClient extends ContactsClient {
  threadPage(
    ...args: Parameters<typeof threadPage> extends [unknown, ...infer Rest]
      ? Rest
      : never
  ) {
    return threadPage(this.transport, ...args);
  }
}
