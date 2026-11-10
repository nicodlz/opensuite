import { JmapClient } from "@opensuite/jmap";
import { err, ok } from "neverthrow";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createMailService } from "../src/services/mail.ts";

const actor = {
  id: "alice",
  email: "alice@example.test",
  role: "user" as const,
};
const origin = "https://mail.example.test";
const firstBinding = "50ac4330-5b78-4ea4-a4c6-6cb6a9547212";
const nextBinding = "0b9e742a-0b5d-464e-92a3-b71e84b42874";
type Credential = {
  accountId: string;
  address: string;
  secret: string;
  bindingId?: string | undefined;
};
function fixture(bindingId?: string) {
  let credential: Credential = {
    accountId: "owned",
    address: actor.email,
    secret: "server-only",
    bindingId,
  };
  let discoveries = 0;
  const service = createMailService({
    origin,
    store: {
      getForOwner: (userId, accountId) =>
        Promise.resolve(
          userId === actor.id &&
            ["default", credential.accountId].includes(accountId)
            ? ok({ ...credential })
            : err({ kind: "not_found" }),
        ),
    },
    client: (current) =>
      new JmapClient(origin, {
        authorization: "test",
        fetch: (_url, input) => {
          if (input?.method !== "POST") {
            discoveries++;
            return Promise.resolve(
              Response.json({
                capabilities: {},
                accounts: {},
                primaryAccounts: { "urn:ietf:params:jmap:mail": "jmap" },
                username: "alice",
                apiUrl: `${origin}/jmap`,
                uploadUrl: `${origin}/upload`,
                downloadUrl: `${origin}/download`,
                state: "s",
              }),
            );
          }
          const request = z
            .object({
              methodCalls: z.array(
                z.tuple([z.string(), z.unknown(), z.string()]),
              ),
            })
            .parse(
              JSON.parse(typeof input.body === "string" ? input.body : "{}"),
            );
          const call = request.methodCalls[0];
          if (call?.[0] !== "Identity/get")
            throw new Error("Unexpected identity request");
          return Promise.resolve(
            Response.json({
              methodResponses: [
                [
                  "Identity/get",
                  {
                    accountId: "jmap",
                    state: "s",
                    list: [
                      { id: "identity", name: "Alice", email: current.address },
                    ],
                    notFound: [],
                  },
                  call[2],
                ],
              ],
              sessionState: "s",
            }),
          );
        },
      }),
  });
  return {
    service,
    discoveries: () => discoveries,
    change: (patch: Partial<Credential>) => {
      credential = { ...credential, ...patch };
    },
  };
}

describe("mailbox linkage identity", () => {
  it("returns the same opaque token for default and canonical account access without credentials", async () => {
    const f = fixture(firstBinding);
    const result = await f.service.identity(actor, "default");
    if (result.isErr()) throw new Error("Identity unavailable");
    expect(result.value).toMatchObject({
      mailboxBindingId: firstBinding,
      address: { email: actor.email },
    });
    expect(JSON.stringify(result.value)).not.toContain("server-only");
    const canonical = await f.service.identity(actor, "owned");
    expect(canonical.isOk() && canonical.value.mailboxBindingId).toBe(
      firstBinding,
    );
  });
  it("marks a legacy store without linkage metadata as unknown", async () => {
    const result = await fixture().service.identity(actor, "default");
    expect(result.isOk() && result.value.mailboxBindingId).toBeNull();
  });
  it("invalidates a cached JMAP session when only the persisted linkage token changes", async () => {
    const f = fixture(firstBinding);
    await f.service.identity(actor, "default");
    await f.service.identity(actor, "default");
    expect(f.discoveries()).toBe(1);
    f.change({ bindingId: nextBinding });
    const replaced = await f.service.identity(actor, "default");
    expect(f.discoveries()).toBe(2);
    expect(replaced.isOk() && replaced.value.mailboxBindingId).toBe(
      nextBinding,
    );
  });
  it("does not derive linkage identity from credentials or the current address", async () => {
    const f = fixture(firstBinding);
    await f.service.identity(actor, "default");
    f.change({ secret: "rotated", address: "renamed@example.test" });
    const result = await f.service.identity(actor, "default");
    expect(result.isOk() && result.value.mailboxBindingId).toBe(firstBinding);
    expect(result.isOk() && result.value.address.email).toBe(
      "renamed@example.test",
    );
  });
  it("refuses foreign accounts and principals before opening a JMAP session", async () => {
    const f = fixture(firstBinding);
    const foreignAccount = await f.service.identity(actor, "foreign");
    const foreignUser = await f.service.identity(
      { ...actor, id: "bob" },
      "default",
    );
    expect(foreignAccount.isErr() && foreignAccount.error.kind).toBe(
      "forbidden",
    );
    expect(foreignUser.isErr() && foreignUser.error.kind).toBe("forbidden");
    expect(f.discoveries()).toBe(0);
  });
});
