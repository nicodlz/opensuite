import { err, ok, type Result } from "neverthrow";

export interface MailboxActor {
  readonly id: string;
  readonly disabled: boolean;
}

export interface MailboxCredential {
  readonly accountId: string;
  readonly address: string;
  readonly secret: string;
}

export interface MailboxFailure {
  readonly kind: "forbidden" | "unavailable";
  readonly message: string;
}

/** This port must scope its lookup by both application user and mailbox ID. */
export interface MailboxStore {
  getForOwner(
    userId: string,
    accountId: string,
  ): Promise<Result<MailboxCredential, MailboxFailure>>;
}

/** The credential is returned only to a server-side mail adapter, never to an API client. */
export const createMailboxAccessService = (store: MailboxStore) => ({
  async credentialFor(
    actor: MailboxActor,
    accountId: string,
  ): Promise<Result<MailboxCredential, MailboxFailure>> {
    if (actor.disabled || actor.id.length === 0 || accountId.length === 0)
      return err({ kind: "forbidden", message: "mailbox access denied" });
    const result = await store.getForOwner(actor.id, accountId);
    if (result.isErr()) return err(result.error);
    // Defense in depth in case a store implementation returns a different account.
    if (result.value.accountId !== accountId)
      return err({ kind: "forbidden", message: "mailbox access denied" });
    return ok(result.value);
  },
});
