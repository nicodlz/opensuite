import {
  contactEmailKey,
  type ContactContent,
  type ContactRecord,
  type ContactCodec,
} from "@opensuite/contracts";
import { err } from "neverthrow";
import type { Actor } from "./accounts.ts";
import { createJmapAccess, fail, value } from "./jmap-access.ts";
import { planContactImport, importTargetsValid } from "./contact-import.ts";
import {
  exportContactCards,
  importMutation,
  importSummary,
} from "./contact-import-result.ts";

const contactsCapability = "urn:ietf:params:jmap:contacts";
const mailCapability = "urn:ietf:params:jmap:mail";
export type ContactsDependencies = Parameters<typeof createJmapAccess>[0];
type Connection = Awaited<
  ReturnType<ReturnType<typeof createJmapAccess>["connect"]>
>;

class ContactsAccess {
  readonly #run: ReturnType<typeof createJmapAccess>["run"];
  readonly #open: ReturnType<typeof createJmapAccess>["connect"];
  readonly #active = new Map<string, number>();
  constructor(dependencies: ContactsDependencies) {
    const access = createJmapAccess(dependencies);
    this.#run = access.run;
    this.#open = access.connect;
  }
  async run<T>(actor: Actor, work: () => Promise<T>) {
    const active = this.#active.get(actor.id) ?? 0;
    if (active >= 2) return err({ kind: "rate_limited" as const });
    this.#active.set(actor.id, active + 1);
    try {
      return await this.#run(work);
    } finally {
      const remaining = (this.#active.get(actor.id) ?? 1) - 1;
      if (remaining === 0) this.#active.delete(actor.id);
      else this.#active.set(actor.id, remaining);
    }
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
    return value(await c.client.contacts.addressBooks(c.session, c.id));
  }
  async writable(c: Connection, bookId: string) {
    const book =
      (await this.books(c)).list.find((item) => item.id === bookId) ??
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
      !(await this.books(c)).list.some(
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
}

class ContactsCore {
  readonly access: ContactsAccess;
  readonly codec: ContactCodec;
  constructor(access: ContactsAccess, codec: ContactCodec) {
    this.access = access;
    this.codec = codec;
  }
  books(actor: Actor, accountId: string) {
    return this.access.run(actor, async () => {
      const c = await this.access.connect(actor, accountId);
      const snapshot = await this.access.books(c);
      const observedAt = new Date().toISOString();
      return {
        books: snapshot.list.map((book) => ({
          id: book.id,
          name: book.name,
          isDefault: book.isDefault,
          mayRead: book.myRights.mayRead,
          mayWrite: book.myRights.mayWrite,
          mayDelete: book.myRights.mayDelete,
          privacy: c.client.contacts.privacyOf(
            book,
            c.session.accounts[c.id]?.isPersonal,
            snapshot.state,
            observedAt,
          ),
        })),
      };
    });
  }
  list(
    actor: Actor,
    accountId: string,
    input: { query: string; position: number; limit: number },
  ) {
    return this.access.run(actor, async () => {
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
        contacts: page.ids.map((id) =>
          this.codec.project(byId.get(id) ?? fail("unavailable")),
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
    return this.access.run(actor, async () => {
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
    return this.access.run(actor, async () => {
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
    return this.access.run(actor, async () => {
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
    return this.access.run(actor, async () => {
      const c = await this.access.connect(actor, accountId);
      if (c.session.primaryAccounts[mailCapability] !== c.id)
        return fail("unavailable");
      const ids = value(
        await c.client.contacts.suggestionIds(c.session, c.id, input.query),
      );
      const matches = (await this.access.get(c, ids)).list;
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
        const key = contactEmailKey(email);
        if (
          !key ||
          seen.has(key) ||
          !(name.toLowerCase().includes(needle) || key.includes(needle))
        )
          return;
        seen.add(key);
        suggestions.push({ name, email, source });
      };
      for (const card of matches) {
        const contact = this.codec.content(card);
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
  async snapshot(c: Connection, text: string) {
    const parsed = this.codec.parse(text);
    if (!parsed.ok) return fail("validation");
    const stored = value(await c.client.contacts.allCards(c.session, c.id));
    return { parsed: parsed.cards, stored };
  }
  previewImport(
    actor: Actor,
    accountId: string,
    input: { vcard: string; bookId?: string | undefined },
  ) {
    return this.access.run(actor, async () => {
      const c = await this.access.connect(actor, accountId);
      if (input.bookId) await this.access.writable(c, input.bookId);
      const { parsed, stored } = await this.snapshot(c, input.vcard);
      return {
        entries: input.bookId
          ? planContactImport(this.codec, parsed, stored, input.bookId).preview
          : this.codec.preview(parsed, stored),
        ...(this.codec.capabilities
          ? { capabilities: this.codec.capabilities }
          : {}),
      };
    });
  }
  import(
    actor: Actor,
    accountId: string,
    input: {
      bookId: string;
      vcard: string;
      state: string;
      targets?: Record<string, string> | undefined;
      enrichExisting?: boolean | undefined;
    },
  ) {
    return this.access.run(actor, async () => {
      const c = await this.access.writeConnection(
        actor,
        accountId,
        input.bookId,
      );
      const { parsed, stored } = await this.snapshot(c, input.vcard);
      if ((await this.access.get(c, [])).state !== input.state)
        return fail("conflict");
      if (!importTargetsValid(parsed.length, input.targets))
        return fail("validation");
      const plan = planContactImport(
        this.codec,
        parsed,
        stored,
        input.bookId,
        input.targets,
        input.enrichExisting === true,
      );
      const mutation = importMutation(plan, input.state);
      if (!mutation) return importSummary(plan, {});
      const result = value(
        await c.client.contacts.setContactBatch(c.session, c.id, mutation),
      );
      return importSummary(plan, result);
    });
  }
  export(actor: Actor, accountId: string, input: { ids: string[] }) {
    return this.access.run(actor, async () => {
      const c = await this.access.connect(actor, accountId);
      const cards = (await this.access.get(c, [...new Set(input.ids)])).list;
      return exportContactCards(this.codec, cards);
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
