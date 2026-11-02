import type { Session } from "./protocol.ts";
import type { MailWriteClient } from "./mail-write.ts";

type Input = {
  session: Session;
  accountId: string;
  draftId: string;
  token: string;
  state: string;
};
type Client = Pick<MailWriteClient, "notificationEmails" | "updateEmail">;

async function read(client: Client, input: Input) {
  const result = await client.notificationEmails(
    input.session,
    input.accountId,
    [input.draftId],
  );
  if (result.isErr()) return undefined;
  const { list, notFound, state } = result.value;
  if (list.length === 0 && notFound.includes(input.draftId))
    return { missing: true as const };
  const email = list[0];
  if (list.length !== 1 || notFound.length || email?.id !== input.draftId)
    return undefined;
  return { missing: false as const, state, keywords: email.keywords };
}

/** Advance Email state before releasing a guard for an uncertain conditional write. */
export async function fenceDraftMutation(client: Client, input: Input) {
  let current = await read(client, input);
  if (!current) return false;
  if (current.missing) return true;
  const marker = `opensuite_guard_${input.token.replaceAll("-", "")}`;
  if (current.state === input.state) {
    if (current.keywords[marker]) return false;
    const added = await client.updateEmail(
      input.session,
      input.accountId,
      input.draftId,
      { [`keywords/${marker}`]: true },
      current.state,
    );
    if (added.isErr()) return false;
    current = await read(client, input);
    if (!current) return false;
    if (current.missing) return true;
    if (current.state === input.state) return false;
  }
  if (!current.keywords[marker]) return true;
  const removed = await client.updateEmail(
    input.session,
    input.accountId,
    input.draftId,
    { [`keywords/${marker}`]: null },
    current.state,
  );
  return removed.isOk();
}
