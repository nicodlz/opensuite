import { InvitationClient } from "./invitations.ts";
import { err, ok } from "neverthrow";
import { z } from "zod";
import {
  JmapCapability,
  type Transport,
  type JmapResult,
  setFailure,
  type Session,
} from "./protocol.ts";
import {
  AddressSchema,
  GetSchema,
  QuerySchema,
  SetSchema,
  usingMail,
} from "./schemas.ts";

const ContactBookSchema = z.object({
  id: z.string(),
  name: z.string(),
  isDefault: z.boolean(),
  shareWith: z.record(z.string(), z.unknown()).nullish(),
  myRights: z.object({
    mayRead: z.boolean(),
    mayWrite: z.boolean(),
    mayDelete: z.boolean(),
    mayShare: z.boolean().optional(),
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
const ContactSetSchema = SetSchema(z.object({ id: z.string() })).extend({
  newState: z.string().optional(),
});
const contactCapabilities = [JmapCapability.core, JmapCapability.contacts];
type ContactChange = {
  create?: Record<string, object>;
  update?: Record<string, object>;
  destroy?: string[];
  ifInState?: string;
};

/** User-scoped contacts and sent-recipient operations on the JMAP transport. */
export class ContactsApi {
  readonly #transport: Transport;
  constructor(transport: Transport) {
    this.#transport = transport;
  }
  /** Projects native ACL evidence without promising future confidentiality. */
  privacyOf(
    book: z.infer<typeof ContactBookSchema>,
    isPersonal: boolean | undefined,
    state: string,
    observedAt: string,
  ) {
    const knownAcl = book.shareWith !== undefined && book.shareWith !== null;
    const shared = knownAcl && Object.keys(book.shareWith ?? {}).length > 0;
    const owner = isPersonal === true && book.myRights.mayShare === true;
    const status: "private" | "shared" | "unknown" = shared
      ? "shared"
      : knownAcl && owner
        ? "private"
        : "unknown";
    return {
      status,
      assurance: "observed" as const,
      state,
      observedAt,
      sharingAllowed: book.myRights.mayShare ?? null,
      bccEligible: false as const,
    };
  }
  addressBooks(session: Session, accountId: string) {
    return this.#transport.call(
      session.apiUrl,
      "AddressBook/get",
      {
        accountId,
        properties: ["id", "name", "isDefault", "myRights", "shareWith"],
      },
      contactCapabilities,
      GetSchema(ContactBookSchema),
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
      QuerySchema,
    );
  }
  async contactCards(
    session: Session,
    accountId: string,
    ids: readonly string[],
  ) {
    const cards = await this.#transport.call(
      session.apiUrl,
      "ContactCard/get",
      { accountId, ids },
      contactCapabilities,
      GetSchema(ContactCardSchema),
    );
    if (cards.isErr() || !cards.value.list.length) return cards;
    // Stalwart omits conversion parameters from an all-properties request.
    // Read them explicitly, without narrowing away unknown CardDAV fields.
    const metadata = await this.#transport.call(
      session.apiUrl,
      "ContactCard/get",
      { accountId, ids, properties: ["id", "addressBookIds", "vCard"] },
      contactCapabilities,
      GetSchema(ContactCardSchema),
    );
    if (metadata.isErr()) return metadata;
    if (metadata.value.state !== cards.value.state)
      return err({
        kind: "method" as const,
        method: "ContactCard/get",
        type: "stateMismatch",
      });
    const byId = new Map(metadata.value.list.map((card) => [card.id, card]));
    if (
      metadata.value.notFound.length ||
      cards.value.list.some((card) => !byId.has(card.id))
    )
      return err({
        kind: "method" as const,
        method: "ContactCard/get",
        type: "notFound",
      });
    return ok({
      ...cards.value,
      list: cards.value.list.map((card) => {
        const conversion = byId.get(card.id)?.["vCard"];
        return conversion === undefined
          ? card
          : Object.assign({}, card, { vCard: conversion });
      }),
    });
  }
  async suggestionIds(
    session: Session,
    accountId: string,
    query: string,
  ): Promise<JmapResult<string[]>> {
    const filtered = await this.queryContacts(session, accountId, {
      filter: { text: query.split(/\s+/)[0] ?? query },
      position: 0,
      limit: 100,
    });
    if (filtered.isErr()) return err(filtered.error);
    // Recently written cards may not have reached the text index yet.
    const first = await this.queryContacts(session, accountId, {
      position: 0,
      limit: 100,
    });
    if (first.isErr()) return err(first.error);
    return ok(
      [...new Set([...filtered.value.ids, ...first.value.ids])].slice(0, 100),
    );
  }
  async allCards(
    session: Session,
    accountId: string,
    max = 5000,
  ): Promise<JmapResult<z.infer<typeof ContactCardSchema>[]>> {
    const ids: string[] = [];
    const loadIds = async (position: number): Promise<JmapResult<string[]>> => {
      const limit = Math.min(100, max + 1 - position);
      const page = await this.queryContacts(session, accountId, {
        position,
        limit,
      });
      if (page.isErr()) return err(page.error);
      ids.push(...page.value.ids);
      if (ids.length > max)
        return err({
          kind: "method",
          method: "ContactCard/query",
          type: "invalidArguments",
        });
      return page.value.ids.length >= limit ? loadIds(ids.length) : ok(ids);
    };
    const allIds = await loadIds(0);
    if (allIds.isErr()) return err(allIds.error);
    const cards: z.infer<typeof ContactCardSchema>[] = [];
    const loadCards = async (
      offset: number,
    ): Promise<JmapResult<z.infer<typeof ContactCardSchema>[]>> => {
      if (offset >= ids.length) return ok(cards);
      const requested = ids.slice(offset, offset + 100);
      const batch = await this.contactCards(session, accountId, requested);
      if (batch.isErr()) return err(batch.error);
      if (
        batch.value.notFound.length ||
        batch.value.list.length !== requested.length
      )
        return err({
          kind: "method",
          method: "ContactCard/get",
          type: "notFound",
        });
      cards.push(...batch.value.list);
      return loadCards(offset + 100);
    };
    return loadCards(0);
  }
  setContactBatch(session: Session, accountId: string, change: ContactChange) {
    return this.#transport.call(
      session.apiUrl,
      "ContactCard/set",
      { accountId, ...change },
      contactCapabilities,
      ContactSetSchema,
    );
  }
  async setContact(session: Session, accountId: string, change: ContactChange) {
    const method = "ContactCard/set";
    const result = await this.setContactBatch(session, accountId, change);
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
    const message = z.object({
      id: z.string(),
      to: z.array(AddressSchema).nullable(),
      cc: z.array(AddressSchema).nullable(),
      bcc: z.array(AddressSchema).nullable(),
    });
    return this.#transport.call(
      session.apiUrl,
      "Email/get",
      { accountId, ids, properties: ["id", "to", "cc", "bcc"] },
      usingMail,
      GetSchema(message),
    );
  }
}

/** Contact operations use the same user-scoped transport as mail and calendar. */
export class ContactsClient extends InvitationClient {
  readonly contacts = new ContactsApi(this.transport);
}
