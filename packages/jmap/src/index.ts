import { ContactsClient } from "./contacts-client.ts";
import { fenceDraftMutation } from "./draft-mutation.ts";
import { mailMapping } from "./mail-content.ts";
import { ScheduledSubmissions } from "./scheduled-send.ts";
import { threadPage } from "./thread-page.ts";

export { JmapCapability } from "./protocol.ts";
export { delayedSendTiming, matchesSubmission } from "./scheduled-send.ts";
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
  readonly mailMapping = mailMapping;
  readonly scheduled = new ScheduledSubmissions(this.transport);
  fenceDraftMutation(input: Parameters<typeof fenceDraftMutation>[1]) {
    return fenceDraftMutation(this, input);
  }
  threadPage(
    ...args: Parameters<typeof threadPage> extends [unknown, ...infer Rest]
      ? Rest
      : never
  ) {
    return threadPage(this.transport, ...args);
  }
}
