# Stable mailbox linkage identity

`POST /mail/identity` additionally returns `mailboxBindingId`, an opaque UUID identifying the current persisted link between an application user and a mailbox. It is distinct from the user's ID, address, credentials and the special JMAP account alias `default`.

The UUID lives on `MailboxLink.bindingId`. The additive migration assigns an independent database-generated UUID to every existing link and retains that default for subsequent inserts, including bulk creation. A password rotation or address change for the same underlying account preserves the token. Replacing the linked account renews it, including A → B → A. Removing and recreating a link also creates a new token.

Activation reads the previous link and chooses its token inside the existing exclusive revocation transaction. A failed transaction does not replace the identity. The owner-scoped credential adapter propagates the token to the mail service; the JMAP session cache key includes it so a recreated link cannot reuse an old cached session merely because its address, account and secret are identical.

The authenticated identity response exposes no mailbox credential. Older stores without this metadata return `null`; older API implementations can omit the field. Both mean that the linkage is unknown. A mobile client should retain its encrypted draft and refuse automatic reassociation based only on an address or `default`. Durable drafts and account-specific checkpoints should be scoped by server origin, authenticated principal and the verified linkage identity.

The identifier is not an authorization token. Reading identity and subsequently writing a draft are separate operations: the mailbox link could change between them. An `expectedMailboxBindingId` check inside the server's draft/submission guards is still needed for an atomic protection against that race; this identity extension does not implement that write precondition. The client must not treat a matching UUID lookup alone as an unlimited authorization to save or send.

Local tests exercise migration backfill/defaults, uniqueness, credential/address changes, account replacement, recreation, rollback, concurrent activation, owner isolation and JMAP cache invalidation. HTTP tests verify the authenticated response and credential redaction. Production requires applying the additive migration before running code that reads the new column. No production migration, provider change or deployment is implied by these local changes.
