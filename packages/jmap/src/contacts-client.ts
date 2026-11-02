import { CalendarClient } from "./calendar-client.ts";
import { err } from "neverthrow";
import { z } from "zod";
import {
  JmapCapability,
  type Transport,
  SetErrorSchema,
  setFailure,
  type Session,
} from "./protocol.ts";
import { GetSchema, QuerySchema } from "./schemas.ts";

const ContactBookSchema = z.object({
  id: z.string(),
  name: z.string(),
  isDefault: z.boolean(),
  myRights: z.object({
    mayRead: z.boolean(),
    mayWrite: z.boolean(),
    mayDelete: z.boolean(),
  }),
});
const ContactCardSchema = z.looseObject({
  id: z.string(),
  addressBookIds: z.record(z.string(), z.boolean()),
  name: z.looseObject({ full: z.string().optional() }).nullable().optional(),
  emails: z
    .record(z.string(), z.looseObject({ address: z.string() }))
    .nullish(),
});
const ContactSetSchema = z.object({
  accountId: z.string(),
  newState: z.string().optional(),
  created: z.record(z.string(), z.object({ id: z.string() })).nullish(),
  updated: z.record(z.string(), z.unknown()).nullish(),
  destroyed: z.array(z.string()).nullish(),
  notCreated: z.record(z.string(), SetErrorSchema).nullish(),
  notUpdated: z.record(z.string(), SetErrorSchema).nullish(),
  notDestroyed: z.record(z.string(), SetErrorSchema).nullish(),
});
type GetFactory = <T>(item: z.ZodType<T>) => z.ZodType<{
  accountId: string;
  state: string;
  list: T[];
  notFound: string[];
}>;
type ContactQuery = {
  accountId: string;
  queryState: string;
  canCalculateChanges: boolean;
  position: number;
  ids: string[];
  total?: number | undefined;
};
const contactCapabilities = [JmapCapability.core, JmapCapability.contacts];

/** User-scoped contacts and sent-recipient operations on the JMAP transport. */
export class ContactsApi {
  readonly #transport: Transport;
  readonly #get: GetFactory;
  readonly #query: z.ZodType<ContactQuery>;
  constructor(
    transport: Transport,
    get: GetFactory,
    query: z.ZodType<ContactQuery>,
  ) {
    this.#transport = transport;
    this.#get = get;
    this.#query = query;
  }
  addressBooks(session: Session, accountId: string) {
    return this.#transport.call(
      session.apiUrl,
      "AddressBook/get",
      { accountId },
      contactCapabilities,
      this.#get(ContactBookSchema),
    );
  }
  queryContacts(
    session: Session,
    accountId: string,
    options: {
      filter?: object;
      position?: number;
      limit?: number;
      calculateTotal?: boolean;
    },
  ) {
    return this.#transport.call(
      session.apiUrl,
      "ContactCard/query",
      { accountId, ...options },
      contactCapabilities,
      this.#query,
    );
  }
  contactCards(session: Session, accountId: string, ids: readonly string[]) {
    return this.#transport.call(
      session.apiUrl,
      "ContactCard/get",
      { accountId, ids },
      contactCapabilities,
      this.#get(ContactCardSchema),
    );
  }
  async setContact(
    session: Session,
    accountId: string,
    change: {
      create?: Record<string, object>;
      update?: Record<string, object>;
      destroy?: string[];
      ifInState?: string;
    },
  ) {
    const method = "ContactCard/set";
    const result = await this.#transport.call(
      session.apiUrl,
      method,
      { accountId, ...change },
      contactCapabilities,
      ContactSetSchema,
    );
    if (result.isErr()) return result;
    const failure =
      setFailure(method, result.value.notCreated) ??
      setFailure(method, result.value.notUpdated) ??
      setFailure(method, result.value.notDestroyed);
    return failure === undefined ? result : err(failure);
  }
  recentRecipients(
    session: Session,
    accountId: string,
    ids: readonly string[],
  ) {
    const address = z.object({
      name: z.string().nullable(),
      email: z.string(),
    });
    const message = z.object({
      id: z.string(),
      to: z.array(address).nullable(),
      cc: z.array(address).nullable(),
      bcc: z.array(address).nullable(),
    });
    return this.#transport.call(
      session.apiUrl,
      "Email/get",
      { accountId, ids, properties: ["id", "to", "cc", "bcc"] },
      [JmapCapability.core, JmapCapability.mail],
      this.#get(message),
    );
  }
}

/** Contact operations use the same user-scoped transport as mail and calendar. */
export class ContactsClient extends CalendarClient {
  readonly contacts = new ContactsApi(this.transport, GetSchema, QuerySchema);
}
