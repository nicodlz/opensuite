import type { InvitationStore } from "@opensuite/db";
import type {
  ParsedInvitation,
  InvitationProtocol,
} from "../../domain/invitations/types.ts";
import type { Actor } from "../accounts.ts";
import { createJmapAccess, fail, value as jmapValue } from "../jmap-access.ts";
import { digest, protocolValue } from "./state.ts";

export type InvitationDependencies = Parameters<typeof createJmapAccess>[0] & {
  intentions?: InvitationStore;
  protocol: InvitationProtocol;
  canSendAs?: (userId: string, address: string) => Promise<string | null>;
  beforeAliasSend?: (userId: string, aliasId: string) => Promise<boolean>;
};
export type Connection = Awaited<
  ReturnType<ReturnType<typeof createJmapAccess>["connect"]>
>;
export type Operation = NonNullable<
  Awaited<ReturnType<InvitationStore["operation"]>>
>;
type MailConnection = Connection;
type CalendarConnection = Connection;

export class InvitationContext {
  readonly access: ReturnType<typeof createJmapAccess>;
  readonly dependencies: InvitationDependencies;
  constructor(dependencies: InvitationDependencies) {
    this.dependencies = dependencies;
    this.access = createJmapAccess(dependencies);
  }
  mail(actor: Actor, accountId: string) {
    return this.access.connect(actor, accountId, "urn:ietf:params:jmap:mail");
  }
  calendar(actor: Actor, accountId: string) {
    return this.access.connect(
      actor,
      accountId,
      "urn:ietf:params:jmap:calendars",
    );
  }
  intentions() {
    return this.dependencies.intentions ?? fail("unavailable");
  }
  async read(c: MailConnection, messageId: string): Promise<ParsedInvitation> {
    const message = jmapValue(
      await c.client.emails(c.session, c.id, [messageId]),
    ).list.find((email) => email.id === messageId);
    if (!message) return fail("not_found");
    const raw = jmapValue(
      await c.client.download(c.session, c.id, message.blobId),
    );
    return protocolValue(await this.dependencies.protocol.parseInvitation(raw));
  }
  async parsedCalendar(c: CalendarConnection, source: string) {
    const blob = jmapValue(
      await c.client.upload(
        c.session,
        c.id,
        Buffer.from(source),
        "text/calendar",
      ),
    );
    const parsed = jmapValue(
      await c.client.parseCalendar(c.session, c.id, blob.blobId),
    ).parsed?.[blob.blobId];
    if (!parsed || parsed.length !== 1 || !parsed[0]) return fail("validation");
    const omitted = new Set([
      "id",
      "baseEventId",
      "calendarIds",
      "isDraft",
      "isOrigin",
      "method",
      "version",
    ]);
    const event = Object.fromEntries(
      Object.entries(parsed[0]).filter(([key]) => !omitted.has(key)),
    );
    return event;
  }
  async getEvent(c: CalendarConnection, id: string) {
    const response = jmapValue(
      await c.client.calendarEvents(c.session, c.id, [id]),
    );
    const event = response.list.find((item) => item.id === id);
    if (!event) return fail("conflict");
    return { event, state: response.state };
  }
  // JMAP query may paginate; rejecting a very large account is safer than missing a duplicate.
  async eventsWithUid(c: CalendarConnection, uid: string) {
    const found: Awaited<ReturnType<InvitationContext["getEvent"]>>["event"][] =
      [];
    const pageAt = async (
      index: number,
      state?: string,
    ): Promise<{ found: typeof found; state: string }> => {
      if (index >= 40) return fail("unavailable");
      const page = jmapValue(
        await c.client.calendarEventPage(c.session, c.id, {
          filter: {},
          position: index * 500,
          limit: 500,
        }),
      );
      if (
        page.events.notFound.length ||
        (state !== undefined && state !== page.events.state)
      )
        return fail("conflict");
      found.push(...page.events.list.filter((event) => event.uid === uid));
      return page.query.ids.length < 500
        ? { found, state: page.events.state }
        : pageAt(index + 1, page.events.state);
    };
    return pageAt(0);
  }
  async rawCalendar(actor: Actor, accountId: string, uid: string) {
    const credential = await this.dependencies.store.getForOwner(
      actor.id,
      accountId,
    );
    if (
      credential.isErr() ||
      (accountId !== "default" && credential.value.accountId !== accountId)
    )
      return fail("forbidden");
    return protocolValue(
      await this.dependencies.protocol.findInvitationObject({
        origin: this.dependencies.origin,
        address: credential.value.address,
        secret: credential.value.secret,
        uid,
      }),
    );
  }
  sameCalendar(left: string, right: string) {
    return (
      protocolValue(this.dependencies.protocol.calendarSignature(left)) ===
      protocolValue(this.dependencies.protocol.calendarSignature(right))
    );
  }
  async verifyCalendar(
    actor: Actor,
    accountId: string,
    operation: NonNullable<Awaited<ReturnType<InvitationStore["operation"]>>>,
  ) {
    const raw = await this.rawCalendar(actor, accountId, operation.series.uid);
    if (!raw || !this.sameCalendar(raw, operation.calendar))
      return fail("conflict");
    return digest(raw);
  }
}
