import { createHash } from "node:crypto";
import { JmapCapability, JmapClient } from "@opensuite/jmap";
import { err, ok, type Result } from "neverthrow";
import type { Delivery, Failure } from "../ingest/contracts.ts";

export interface Destination {
  id: string;
  origin: string;
  authorization: string;
  quarantineMailbox: string;
  rewriteSessionUrls?: boolean;
}
const keyword = (key: string) => `opensuite-${key}`;
const receivedDate = (value: string) =>
  new Date(Math.floor(Date.parse(value) / 1000) * 1000).toISOString();
const hash = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const messageId = (bytes: Uint8Array) => {
  const head =
    Buffer.from(
      bytes.buffer,
      bytes.byteOffset,
      Math.min(bytes.byteLength, 1_000_000),
    )
      .toString("latin1")
      .split(/\r?\n\r?\n/, 1)[0] ?? "";
  const match = /(?:^|\r?\n)message-id:\s*<([^<>\r\n]+)>/i.exec(head);
  return match?.[1];
};
export function jmapDelivery(destinations: Destination[]): Delivery {
  const connect = async (destination: string, quarantine = false) => {
    const config = destinations.find((item) => item.id === destination);
    if (config === undefined)
      return err({ message: "Destination is not configured" });
    const client = new JmapClient(config.origin, {
      authorization: config.authorization,
      ...(config.rewriteSessionUrls === true
        ? { rewriteSessionUrlsToOrigin: config.origin }
        : {}),
    });
    const session = await client.discover();
    if (session.isErr())
      return err({
        message: `JMAP discovery: ${JSON.stringify(session.error)}`,
      });
    const account = session.value.primaryAccounts[JmapCapability.mail];
    if (account === undefined)
      return err({ message: "No primary mail account" });
    const boxes = await client.mailboxes(session.value, account);
    if (boxes.isErr())
      return err({ message: `JMAP mailboxes: ${JSON.stringify(boxes.error)}` });
    const mailbox = boxes.value.list.find((box) =>
      quarantine ? box.id === config.quarantineMailbox : box.role === "inbox",
    );
    if (mailbox === undefined)
      return err({ message: "Destination mailbox missing" });
    return ok({
      client,
      session: session.value,
      account,
      mailbox: mailbox.id,
      origin: new URL(config.origin).origin,
    });
  };
  return {
    async import(
      destination,
      bytes,
      quarantine,
      receivedAt,
      key,
      uploads,
      beforeImport,
    ) {
      const connection = await connect(destination, quarantine);
      if (connection.isErr()) return connection;
      const { client, session, account, mailbox, origin } = connection.value;
      // HTTP upload avoids base64 and JSON copies for every message size.
      const uploadKey = JSON.stringify([origin, account]);
      let blobId = uploads.get(uploadKey);
      if (blobId === undefined) {
        const uploaded = await client.upload(session, account, bytes);
        if (uploaded.isErr())
          return err({
            message: `JMAP upload: ${JSON.stringify(uploaded.error)}`,
          });
        blobId = uploaded.value.blobId;
        uploads.set(uploadKey, blobId);
      }
      const started = await beforeImport();
      if (started.isErr()) return err(started.error);
      const imported = await client.importEmail(session, account, {
        blobId,
        mailboxIds: { [mailbox]: true },
        keywords: { [keyword(key)]: true },
        receivedAt: new Date(receivedAt).toISOString(),
      });
      if (imported.isErr()) {
        const error = imported.error;
        const ambiguous =
          (error.kind === "network" && error.beforeRequest !== true) ||
          error.kind === "invalidResponse" ||
          error.kind === "http" ||
          (error.kind === "request" &&
            (error.status >= 500 || [408, 429].includes(error.status))) ||
          (error.kind === "method" &&
            ![
              "invalidArguments",
              "unknownMethod",
              "unknownCapability",
              "forbidden",
              "accountNotFound",
              "accountNotSupportedByMethod",
              "accountReadOnly",
              "requestTooLarge",
            ].includes(error.type));
        return err({
          message: `JMAP import: ${JSON.stringify(error)}`,
          ambiguous,
          permanent:
            (error.kind === "set" || error.kind === "method") &&
            [
              "invalidArguments",
              "invalidProperties",
              "invalidEmail",
              "invalidKeywords",
              "forbidden",
            ].includes(error.type),
        });
      }
      return ok(imported.value.id);
    },
    async reconcile(
      destination,
      bytes,
      quarantine,
      receivedAt,
      key,
      legacy = false,
    ) {
      const connection = await connect(destination, quarantine);
      if (connection.isErr()) return connection;
      const { client, session, account, mailbox } = connection.value;
      const matches: string[] = [];
      const expectedId = messageId(bytes);
      if (legacy && expectedId === undefined)
        return err({ message: "Legacy reconciliation requires a Message-ID" });
      const expectedHash = hash(bytes);
      let candidates = 0;
      const scan = async (position: number): Promise<Result<void, Failure>> => {
        const query = await client.queryEmails(session, account, {
          // Legacy recovery scans the account: servers need not index Message-ID
          // headers consistently. Exact Message-ID and raw bytes are checked below.
          ...(legacy ? {} : { filter: { hasKeyword: keyword(key) } }),
          position,
          limit: 100,
        });
        if (query.isErr())
          return err({
            message: `JMAP reconciliation query: ${JSON.stringify(query.error)}`,
          });
        const ids = query.value.ids;
        candidates += ids.length;
        if (ids.length === 0) return ok(undefined);
        const emails = await client.emails(session, account, ids);
        if (
          emails.isErr() ||
          emails.value.notFound.length > 0 ||
          emails.value.list.length !== ids.length
        )
          return err({
            message: "JMAP reconciliation could not read all candidates",
          });
        const checked = await emails.value.list.reduce<
          Promise<Result<void, Failure>>
        >(
          (previous, email) =>
            previous.then(async (result) => {
              if (result.isErr()) return result;
              if (
                (!legacy &&
                  (email.mailboxIds[mailbox] !== true ||
                    email.keywords[keyword(key)] !== true ||
                    Date.parse(email.receivedAt) !==
                      Date.parse(receivedDate(receivedAt)))) ||
                (expectedId !== undefined &&
                  !email.messageId?.includes(expectedId))
              )
                return ok(undefined);
              const raw = await client.download(session, account, email.blobId);
              if (raw.isErr())
                return err({
                  message: `JMAP reconciliation download: ${JSON.stringify(raw.error)}`,
                });
              if (
                raw.value.byteLength === bytes.byteLength &&
                hash(raw.value) === expectedHash
              )
                matches.push(email.id);
              return ok(undefined);
            }),
          Promise.resolve(ok(undefined)),
        );
        if (checked.isErr()) return checked;
        return ids.length < 100 ? ok(undefined) : scan(position + ids.length);
      };
      const scanned = await scan(0);
      if (scanned.isErr()) return err(scanned.error);
      if (!legacy && candidates > 0 && matches.length !== candidates)
        return err({
          message: "Keyword candidates do not all match the original message",
          ambiguous: true,
        });
      return ok(matches);
    },
  };
}
