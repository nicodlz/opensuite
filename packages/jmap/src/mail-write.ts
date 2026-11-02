import { createdItem, updatedItem, destroyedItem } from "./set-results.ts";
import { err, ok } from "neverthrow";
import { z } from "zod";
import { JmapCapability, type JmapResult, type Session } from "./protocol.ts";
import { MailReadClient } from "./mail-read.ts";
import {
  IdentitySchema,
  BlobSchema,
  UploadSchema,
  ImportSchema,
  SetSchema,
  GetSchema,
  usingMail,
} from "./schemas.ts";

const expand = (template: string, values: Record<string, string>) =>
  template.replace(/\{([^}]+)\}/g, (_match, key: string) =>
    encodeURIComponent(values[key] ?? ""),
  );

export class MailWriteClient extends MailReadClient {
  async createEmail(
    session: Session,
    accountId: string,
    email: object,
  ): Promise<JmapResult<{ id: string; threadId: string }>> {
    const method = "Email/set";
    const result = await this.transport.call(
      session.apiUrl,
      method,
      { accountId, create: { item: email } },
      usingMail,
      SetSchema(z.object({ id: z.string(), threadId: z.string() })),
    );
    return createdItem(method, result);
  }
  async destroyEmail(
    session: Session,
    accountId: string,
    id: string,
  ): Promise<JmapResult<void>> {
    const method = "Email/set";
    const result = await this.transport.call(
      session.apiUrl,
      method,
      { accountId, destroy: [id] },
      usingMail,
      SetSchema(z.unknown()),
    );
    return destroyedItem(method, result, id);
  }
  identities(session: Session, accountId: string) {
    return this.transport.call(
      session.apiUrl,
      "Identity/get",
      { accountId, properties: ["id", "name", "email"] },
      [JmapCapability.core, JmapCapability.submission],
      GetSchema(IdentitySchema),
    );
  }
  async uploadBlob(
    session: Session,
    accountId: string,
    data: string,
    type = "application/octet-stream",
  ): Promise<JmapResult<z.infer<typeof BlobSchema>>> {
    const method = "Blob/upload";
    const result = await this.transport.call(
      session.apiUrl,
      method,
      {
        accountId,
        create: { item: { data: [{ "data:asBase64": data }], type } },
      },
      [JmapCapability.core, JmapCapability.blob],
      SetSchema(BlobSchema),
    );
    return createdItem(method, result);
  }
  async upload(
    session: Session,
    accountId: string,
    bytes: Uint8Array,
    type = "message/rfc822",
  ) {
    const url = expand(session.uploadUrl, { accountId });
    return this.transport.json(url, UploadSchema, {
      method: "POST",
      headers: { "Content-Type": type },
      body: new Blob(
        [
          bytes.buffer instanceof ArrayBuffer
            ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
            : Uint8Array.from(bytes),
        ],
        { type },
      ),
    });
  }
  async download(
    session: Session,
    accountId: string,
    blobId: string,
    name = "blob",
    type = "application/octet-stream",
  ): Promise<JmapResult<Uint8Array>> {
    const url = expand(session.downloadUrl, { accountId, blobId, name, type });
    const response = await this.transport.request(url);
    if (response.isErr()) return err(response.error);
    try {
      return ok(new Uint8Array(await response.value.arrayBuffer()));
    } catch (cause) {
      return err({ kind: "network", message: String(cause) });
    }
  }
  async importEmail(
    session: Session,
    accountId: string,
    input: {
      blobId: string;
      mailboxIds: Record<string, boolean>;
      keywords?: Record<string, boolean>;
      receivedAt?: string;
    },
  ): Promise<JmapResult<z.infer<typeof ImportSchema>>> {
    const method = "Email/import";
    const result = await this.transport.call(
      session.apiUrl,
      method,
      { accountId, emails: { item: input } },
      usingMail,
      SetSchema(ImportSchema),
    );
    return createdItem(method, result);
  }
  async updateEmail(
    session: Session,
    accountId: string,
    id: string,
    patch: Record<string, unknown>,
  ): Promise<JmapResult<void>> {
    const method = "Email/set";
    const result = await this.transport.call(
      session.apiUrl,
      method,
      { accountId, update: { [id]: patch } },
      usingMail,
      SetSchema(z.unknown()),
    );
    return updatedItem(method, result, id);
  }
  async submit(
    session: Session,
    accountId: string,
    emailId: string,
    identityId: string,
    envelope?: { mailFrom: { email: string }; rcptTo: { email: string }[] },
    sentMailboxId?: string,
  ): Promise<JmapResult<{ id: string }>> {
    const method = "EmailSubmission/set";
    const result = await this.transport.call(
      session.apiUrl,
      method,
      {
        accountId,
        ...(sentMailboxId === undefined
          ? {}
          : {
              onSuccessUpdateEmail: {
                "#item": {
                  mailboxIds: { [sentMailboxId]: true },
                  "keywords/$draft": null,
                  "keywords/$seen": true,
                },
              },
            }),
        create: {
          item: {
            emailId,
            identityId,
            ...(envelope === undefined ? {} : { envelope }),
          },
        },
      },
      [JmapCapability.core, JmapCapability.mail, JmapCapability.submission],
      SetSchema(z.object({ id: z.string() })),
      sentMailboxId === undefined ? undefined : "Email/set",
    );
    return createdItem(method, result);
  }
}
