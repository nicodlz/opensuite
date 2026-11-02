import {
  ContactContentSchema,
  type ContactContent,
  type ContactRecord,
  type ContactCodec,
} from "@opensuite/contracts";
import type { Actor } from "./accounts.ts";
import {
  createJmapAccess,
  fail,
  value,
  type AccessFailureKind,
} from "./jmap-access.ts";

export type ContactsFailure = { kind: AccessFailureKind };
export const contactsCapability = "urn:ietf:params:jmap:contacts";
const mailCapability = "urn:ietf:params:jmap:mail";
export const emailKey = (email: string) => email.trim().toLowerCase();
export type ContactsDependencies = Parameters<typeof createJmapAccess>[0];
type Connection = Awaited<
  ReturnType<ReturnType<typeof createJmapAccess>["connect"]>
>;

export class ContactsAccess {
  readonly run: ReturnType<typeof createJmapAccess>["run"];
  readonly #open: ReturnType<typeof createJmapAccess>["connect"];
  constructor(dependencies: ContactsDependencies) {
    const access = createJmapAccess(dependencies);
    this.run = access.run;
    this.#open = access.connect;
  }
  async connect(actor: Actor, accountId: string) {
    const c = await this.#open(actor, accountId, contactsCapability);
    if (
      !(contactsCapability in c.session.capabilities) ||
      !(
        contactsCapability in
        (c.session.accounts[c.id]?.accountCapabilities ?? {})
      )
    )
      return fail("unavailable");
    return c;
  }
  async books(c: Connection) {
    return value(await c.client.contacts.addressBooks(c.session, c.id)).list;
  }
  async writable(c: Connection, bookId: string) {
    const book =
      (await this.books(c)).find((item) => item.id === bookId) ??
      fail("not_found");
    if (!book.myRights.mayWrite) fail("forbidden");
  }
  async writeConnection(actor: Actor, accountId: string, bookId: string) {
    const connection = await this.connect(actor, accountId);
    await this.writable(connection, bookId);
    return connection;
  }
  async get(c: Connection, ids: string[]) {
    const result = value(
      await c.client.contacts.contactCards(c.session, c.id, ids),
    );
    if (result.notFound.length || result.list.length !== ids.length)
      return fail("not_found");
    return result;
  }
  async requireRights(
    c: Connection,
    card: ContactRecord,
    right: "mayWrite" | "mayDelete",
  ) {
    if (
      !(await this.books(c)).some(
        (book) => card.addressBookIds[book.id] && book.myRights[right],
      )
    )
      fail("forbidden");
  }
  async item(
    actor: Actor,
    accountId: string,
    id: string,
    right: "mayWrite" | "mayDelete",
  ) {
    const connection = await this.connect(actor, accountId);
    const card =
      (await this.get(connection, [id])).list[0] ?? fail("not_found");
    await this.requireRights(connection, card, right);
    return { connection, card };
  }
  async createCard(c: Connection, state: string, card: object) {
    return value(
      await c.client.contacts.setContact(c.session, c.id, {
        ifInState: state,
        create: { item: card },
      }),
    );
  }
  async all(c: Connection, max = 5000) {
    const ids: string[] = [];
    const nextPage = async (position: number): Promise<void> => {
      const limit = Math.min(100, max + 1 - position);
      const page = value(
        await c.client.contacts.queryContacts(c.session, c.id, {
          position,
          limit,
        }),
      );
      ids.push(...page.ids);
      if (ids.length > max) fail("validation");
      if (page.ids.length === limit) await nextPage(position + limit);
    };
    await nextPage(0);
    const cards: ContactRecord[] = [];
    const load = async (position: number): Promise<void> => {
      if (position >= ids.length) return;
      cards.push(
        ...(await this.get(c, ids.slice(position, position + 100))).list,
      );
      await load(position + 100);
    };
    await load(0);
    return cards;
  }
}

export class ContactsCore {
  readonly access: ContactsAccess;
  readonly codec: ContactCodec;
  constructor(access: ContactsAccess, codec: ContactCodec) {
    this.access = access;
    this.codec = codec;
  }
  books(actor: Actor, accountId: string) {
    return this.access.run(async () => {
      const c = await this.access.connect(actor, accountId);
      return {
        books: (await this.access.books(c)).map((book) => ({
          id: book.id,
          name: book.name,
          isDefault: book.isDefault,
          mayRead: book.myRights.mayRead,
          mayWrite: book.myRights.mayWrite,
          mayDelete: book.myRights.mayDelete,
        })),
      };
    });
  }
  list(
    actor: Actor,
    accountId: string,
    input: { query: string; position: number; limit: number },
  ) {
    return this.access.run(async () => {
      const c = await this.access.connect(actor, accountId);
      const page = value(
        await c.client.contacts.queryContacts(c.session, c.id, {
          ...(input.query ? { filter: { text: input.query } } : {}),
          position: input.position,
          limit: input.limit,
          calculateTotal: true,
        }),
      );
      if (page.total === undefined) return fail("unavailable");
      const result = await this.access.get(c, page.ids);
      const byId = new Map(result.list.map((card) => [card.id, card]));
      return {
        contacts: page.ids.map(
          (id) =>
            this.codec.project(byId.get(id) ?? fail("unavailable")) ??
            fail("unavailable"),
        ),
        state: result.state,
        position: page.position,
        total: page.total,
      };
    });
  }
  create(
    actor: Actor,
    accountId: string,
    input: { bookId: string; contact: ContactContent; state: string },
  ) {
    return this.access.run(async () => {
      const c = await this.access.writeConnection(
        actor,
        accountId,
        input.bookId,
      );
      const result = await this.access.createCard(
        c,
        input.state,
        this.codec.create(input.contact, input.bookId),
      );
      return { id: result.created?.["item"]?.id ?? fail("unavailable") };
    });
  }
  update(
    actor: Actor,
    accountId: string,
    input: { contactId: string; contact: ContactContent; state: string },
  ) {
    return this.access.run(async () => {
      const { connection: c, card } = await this.access.item(
        actor,
        accountId,
        input.contactId,
        "mayWrite",
      );
      const result = value(
        await c.client.contacts.setContact(c.session, c.id, {
          ifInState: input.state,
          update: { [card.id]: this.codec.patch(card, input.contact) },
        }),
      );
      if (!result.updated || !Object.hasOwn(result.updated, card.id))
        return fail("unavailable");
      return { success: true as const };
    });
  }
  delete(
    actor: Actor,
    accountId: string,
    input: { contactId: string; state: string },
  ) {
    return this.access.run(async () => {
      const { connection: c, card } = await this.access.item(
        actor,
        accountId,
        input.contactId,
        "mayDelete",
      );
      const result = value(
        await c.client.contacts.setContact(c.session, c.id, {
          ifInState: input.state,
          destroy: [card.id],
        }),
      );
      if (!result.destroyed?.includes(card.id)) return fail("unavailable");
      return { success: true as const };
    });
  }
  suggest(
    actor: Actor,
    accountId: string,
    input: { query: string; limit: number },
  ) {
    return this.access.run(async () => {
      const c = await this.access.connect(actor, accountId);
      if (c.session.primaryAccounts[mailCapability] !== c.id)
        return fail("unavailable");
      const matches = await this.access.all(c);
      const suggestions: {
        name: string;
        email: string;
        source: "contact" | "recent";
      }[] = [];
      const seen = new Set<string>();
      const needle = input.query.toLowerCase();
      const add = (
        name: string,
        email: string,
        source: "contact" | "recent",
      ) => {
        const parsed =
          ContactContentSchema.shape.emails.element.safeParse(email);
        const key = emailKey(email);
        if (
          !parsed.success ||
          seen.has(key) ||
          !(name.toLowerCase().includes(needle) || key.includes(needle))
        )
          return;
        seen.add(key);
        suggestions.push({ name, email, source });
      };
      for (const card of matches) {
        const contact = this.codec.content(card) ?? fail("unavailable");
        for (const email of contact.emails) add(contact.name, email, "contact");
      }
      const sent = value(await c.client.mailboxes(c.session, c.id)).list.find(
        (box) => box.role === "sent",
      );
      if (sent === undefined) return fail("unavailable");
      const page = value(
        await c.client.queryEmails(c.session, c.id, {
          filter: { inMailbox: sent.id },
          sort: [{ property: "sentAt", isAscending: false }],
          limit: 50,
        }),
      );
      const recent = value(
        await c.client.contacts.recentRecipients(c.session, c.id, page.ids),
      );
      if (recent.notFound.length) return fail("unavailable");
      const byId = new Map(recent.list.map((email) => [email.id, email]));
      for (const id of page.ids) {
        const message = byId.get(id) ?? fail("unavailable");
        for (const recipient of [
          ...(message.to ?? []),
          ...(message.cc ?? []),
          ...(message.bcc ?? []),
        ])
          add(recipient.name ?? "", recipient.email, "recent");
      }
      return { suggestions: suggestions.slice(0, input.limit) };
    });
  }
}

class ContactTransfers {
  readonly access: ContactsAccess;
  readonly codec: ContactCodec;
  constructor(access: ContactsAccess, codec: ContactCodec) {
    this.access = access;
    this.codec = codec;
  }
  async preview(c: Connection, text: string) {
    let parsed: ReturnType<ContactCodec["parse"]>;
    try {
      parsed = this.codec.parse(text);
    } catch {
      return fail("validation");
    }
    const stored = await this.access.all(c);
    return this.codec.preview(parsed, stored);
  }
  previewImport(actor: Actor, accountId: string, input: { vcard: string }) {
    return this.access.run(async () => ({
      entries: await this.preview(
        await this.access.connect(actor, accountId),
        input.vcard,
      ),
    }));
  }
  import(
    actor: Actor,
    accountId: string,
    input: { bookId: string; vcard: string; state: string },
  ) {
    return this.access.run(async () => {
      const c = await this.access.writeConnection(
        actor,
        accountId,
        input.bookId,
      );
      const entries = await this.preview(c, input.vcard);
      const valid = entries.filter(
        (entry) => entry.contact !== null && !entry.duplicate,
      );
      const current = await this.access.get(c, []);
      if (current.state !== input.state) return fail("conflict");
      const save = async (index: number, state: string): Promise<number> => {
        const entry = valid[index];
        if (entry === undefined) return 0;
        if (entry.contact === null) return save(index + 1, state);
        const result = await this.access.createCard(
          c,
          state,
          this.codec.create(entry.contact, input.bookId),
        );
        if (!result.created?.["item"]?.id || !result.newState)
          return fail("unavailable");
        return 1 + (await save(index + 1, result.newState));
      };
      const imported = await save(0, input.state);
      return { imported, skipped: entries.length - imported };
    });
  }
  export(actor: Actor, accountId: string, input: { ids: string[] }) {
    return this.access.run(async () => {
      const c = await this.access.connect(actor, accountId);
      const cards = (await this.access.get(c, input.ids)).list;
      return {
        vcard: this.codec.serialize(
          cards.map((card) => this.codec.content(card) ?? fail("unavailable")),
        ),
        warnings: cards.flatMap((card) => this.codec.warnings(card)),
      };
    });
  }
}
export function createContactsService(
  dependencies: ContactsDependencies & { codec: ContactCodec },
) {
  const access = new ContactsAccess(dependencies);
  const core = new ContactsCore(access, dependencies.codec);
  const transfer = new ContactTransfers(access, dependencies.codec);
  return {
    books: core.books.bind(core),
    list: core.list.bind(core),
    create: core.create.bind(core),
    update: core.update.bind(core),
    delete: core.delete.bind(core),
    suggest: core.suggest.bind(core),
    previewImport: transfer.previewImport.bind(transfer),
    import: transfer.import.bind(transfer),
    export: transfer.export.bind(transfer),
  };
}
export type ContactsService = ReturnType<typeof createContactsService>;
