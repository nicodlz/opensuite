import { z } from "zod";
import type { MigrationMailClient } from "./migration-mail.ts";
import type { Session } from "./protocol.ts";

const Names = z.record(
  z.string(),
  z.object({ name: z.string(), parentId: z.string().nullable() }),
);
export type MigrationMailboxNames = z.infer<typeof Names>;
type Input = {
  client: Pick<MigrationMailClient, "mailboxes">;
  session: Session;
  accountId: string;
  ids: readonly string[];
};

export async function captureMigrationDestinations(input: Input) {
  const result = await input.client.mailboxes(input.session, input.accountId);
  if (result.isErr() || result.value.accountId !== input.accountId)
    return { kind: "retry" as const };
  const requested = new Set(input.ids);
  const matches = result.value.list.filter((mailbox) =>
    requested.has(mailbox.id),
  );
  if (
    matches.length !== requested.size ||
    new Set(matches.map((mailbox) => mailbox.id)).size !== requested.size
  )
    return { kind: "changed" as const };
  const names: MigrationMailboxNames = Object.fromEntries(
    matches.map((mailbox) => [
      mailbox.id,
      { name: mailbox.name, parentId: mailbox.parentId },
    ]),
  );
  return { kind: "ready" as const, names };
}

export async function checkMigrationDestinations(
  input: Input & { expected: unknown },
) {
  const expected = Names.safeParse(input.expected);
  if (!expected.success) return { kind: "changed" as const };
  const current = await captureMigrationDestinations(input);
  if (current.kind !== "ready") return current;
  for (const id of input.ids) {
    const before = expected.data[id];
    const after = current.names[id];
    if (
      before === undefined ||
      after === undefined ||
      before.name !== after.name ||
      before.parentId !== after.parentId
    )
      return { kind: "changed" as const };
  }
  return { kind: "ready" as const };
}
