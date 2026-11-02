import { z } from "zod";
import { err, ok } from "neverthrow";
import { ContactsClient } from "./contacts-client.ts";
import type { JmapResult, Session } from "./protocol.ts";
import { GetSchema, ImportSchema, SetSchema, usingMail } from "./schemas.ts";
import { createdItem, updatedItem } from "./set-results.ts";

const MigrationEmailSchema = z.object({
  id: z.string(),
  blobId: z.string(),
  size: z.number().int().nonnegative(),
  messageId: z.array(z.string()).nullable(),
  keywords: z.record(z.string(), z.boolean()),
});

export class MigrationMailClient extends ContactsClient {
  migrationEmails(session: Session, accountId: string, ids: readonly string[]) {
    return this.transport.call(
      session.apiUrl,
      "Email/get",
      {
        accountId,
        ids,
        properties: ["id", "blobId", "size", "messageId", "keywords"],
      },
      usingMail,
      GetSchema(MigrationEmailSchema),
    );
  }

  async migrationImport(
    session: Session,
    accountId: string,
    input: Parameters<ContactsClient["importEmail"]>[2],
    ifInState: string,
  ): Promise<JmapResult<z.infer<typeof ImportSchema> & { newState: string }>> {
    const method = "Email/import";
    const result = await this.transport.call(
      session.apiUrl,
      method,
      { accountId, ifInState, emails: { item: input } },
      usingMail,
      SetSchema(ImportSchema).extend({ newState: z.string() }),
    );
    if (result.isErr()) return err(result.error);
    if (result.value.accountId !== accountId)
      return err({ kind: "invalidResponse", message: "Wrong import account" });
    const created = createdItem(method, result);
    return created.isErr()
      ? err(created.error)
      : ok({ ...created.value, newState: result.value.newState });
  }

  async migrationMap(
    session: Session,
    accountId: string,
    id: string,
    patch: Record<string, unknown>,
    ifInState: string,
  ): Promise<JmapResult<{ newState: string }>> {
    const method = "Email/set";
    const result = await this.transport.call(
      session.apiUrl,
      method,
      { accountId, ifInState, update: { [id]: patch } },
      usingMail,
      SetSchema(z.unknown()).extend({ newState: z.string() }),
    );
    if (result.isErr()) return err(result.error);
    if (result.value.accountId !== accountId)
      return err({ kind: "invalidResponse", message: "Wrong update account" });
    const updated = updatedItem(method, result, id);
    return updated.isErr()
      ? err(updated.error)
      : ok({ newState: result.value.newState });
  }
}
