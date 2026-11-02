import { contactVcardCodec } from "@opensuite/core/adapters/contacts";
import { createContactsService } from "@opensuite/core/services/contacts";
import type { createMailboxStore } from "@opensuite/db";

type MailboxStore = Extract<
  ReturnType<typeof createMailboxStore>,
  { value: unknown }
>["value"];

/** Compose Contacts with the same owner-scoped mailbox credentials used by mail. */
export function createContactsRuntime(mailboxes: MailboxStore, origin: string) {
  return createContactsService({
    codec: contactVcardCodec,
    store: {
      getForOwner: async (userId, accountId) =>
        mailboxes.getForOwner(userId, accountId),
    },
    origin,
  });
}
