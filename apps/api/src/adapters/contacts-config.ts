import { contactVcardCodec } from "@opensuite/core/adapters/contacts";
import type { createMailboxStore } from "@opensuite/db";

type MailboxStore = Extract<
  ReturnType<typeof createMailboxStore>,
  { value: unknown }
>["value"];

/** Compose Contacts with the same owner-scoped mailbox credentials used by mail. */
export function contactsConfig(mailboxes: MailboxStore, origin: string) {
  return {
    codec: contactVcardCodec,
    store: {
      getForOwner: async (userId: string, accountId: string) =>
        mailboxes.getForOwner(userId, accountId),
    },
    origin,
  };
}
