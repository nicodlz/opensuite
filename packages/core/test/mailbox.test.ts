import { err, ok } from "neverthrow";
import { describe, expect, it, vi } from "vitest";
import {
  type MailboxFailure,
  type MailboxStore,
  createMailboxAccessService,
} from "../src/services/mailbox.ts";

describe("mailbox access", () => {
  it("uses both the authenticated actor and mailbox identity", async () => {
    const getForOwner = vi.fn<MailboxStore["getForOwner"]>(
      (userId, accountId) =>
        Promise.resolve(
          userId === "alice" && accountId === "alice-mail"
            ? ok({
                accountId,
                address: "alice@example.test",
                secret: "server-only",
              })
            : err<never, MailboxFailure>({
                kind: "forbidden",
                message: "mailbox access denied",
              }),
        ),
    );
    const service = createMailboxAccessService({ getForOwner });
    expect(
      (
        await service.credentialFor(
          { id: "alice", disabled: false },
          "alice-mail",
        )
      ).isOk(),
    ).toBe(true);
    expect(
      (
        await service.credentialFor(
          { id: "bob", disabled: false },
          "alice-mail",
        )
      ).isErr(),
    ).toBe(true);
    expect(
      (
        await service.credentialFor(
          { id: "alice", disabled: true },
          "alice-mail",
        )
      ).isErr(),
    ).toBe(true);
    expect(getForOwner).toHaveBeenCalledTimes(2);
  });
});
