import { JmapCapability, JmapClient } from "@opensuite/jmap";
import { err, ok } from "neverthrow";
import type { Delivery } from "../ingest/contracts.ts";

export interface Destination {
  id: string;
  origin: string;
  authorization: string;
  quarantineMailbox: string;
}
export function jmapDelivery(destinations: Destination[]): Delivery {
  return {
    async import(destination, bytes, quarantine) {
      const config = destinations.find((item) => item.id === destination);
      if (config === undefined)
        return err({ message: "Destination is not configured" });
      const client = new JmapClient(config.origin, {
        authorization: config.authorization,
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
        return err({
          message: `JMAP mailboxes: ${JSON.stringify(boxes.error)}`,
        });
      const mailbox = boxes.value.list.find((box) =>
        quarantine ? box.id === config.quarantineMailbox : box.role === "inbox",
      );
      if (mailbox === undefined)
        return err({ message: "Destination mailbox missing" });
      // Keep JSON requests below Stalwart's default request limit; use HTTP for large mail.
      let blobId: string;
      if (bytes.byteLength <= 6_000_000) {
        const uploaded = await client.uploadBlob(
          session.value,
          account,
          Buffer.from(bytes).toString("base64"),
          "message/rfc822",
        );
        if (uploaded.isErr())
          return err({
            message: `JMAP Blob/upload: ${JSON.stringify(uploaded.error)}`,
          });
        blobId = uploaded.value.id;
      } else {
        const uploaded = await client.upload(session.value, account, bytes);
        if (uploaded.isErr())
          return err({
            message: `JMAP upload: ${JSON.stringify(uploaded.error)}`,
          });
        blobId = uploaded.value.blobId;
      }
      const imported = await client.importEmail(session.value, account, {
        blobId,
        mailboxIds: { [mailbox.id]: true },
      });
      if (imported.isErr()) {
        const error = imported.error;
        // A request or response failure after sending import may conceal a commit.
        const ambiguous =
          error.kind === "network" ||
          error.kind === "invalidResponse" ||
          error.kind === "http" ||
          (error.kind === "request" && error.status >= 500);
        return err({
          message: `JMAP import: ${JSON.stringify(error)}`,
          ambiguous,
        });
      }
      return ok(imported.value.id);
    },
  };
}
