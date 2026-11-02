import { expect, it } from "vitest";
import { z } from "zod";
import { JmapClient, type Session } from "../src/index.ts";

const session: Session = {
  capabilities: {},
  accounts: {},
  primaryAccounts: {},
  username: "owner",
  apiUrl: "https://mail.example.test/jmap",
  uploadUrl: "https://mail.example.test/upload/{accountId}",
  downloadUrl: "https://mail.example.test/download/{accountId}/{blobId}",
  state: "s",
};
const request = z.object({
  methodCalls: z.array(
    z.tuple([
      z.string(),
      z.object({
        accountId: z.string(),
        ids: z.array(z.string()),
        properties: z.array(z.string()),
      }),
      z.string(),
    ]),
  ),
});

it("requests only import-reconciliation metadata and validates the JMAP response", async () => {
  let valid = true;
  const client = new JmapClient("https://mail.example.test", {
    authorization: "fixture",
    fetch: (_url, init) => {
      if (typeof init?.body !== "string") throw new Error("Missing call");
      const call = request.parse(JSON.parse(init.body)).methodCalls[0];
      expect(call).toEqual([
        "Email/get",
        {
          accountId: "owner",
          ids: ["one"],
          properties: ["id", "blobId", "size", "messageId", "keywords"],
        },
        "0",
      ]);
      return Promise.resolve(
        Response.json({
          sessionState: "s",
          methodResponses: [
            [
              "Email/get",
              {
                accountId: "owner",
                state: "s",
                notFound: [],
                list: [
                  valid
                    ? {
                        id: "one",
                        blobId: "blob",
                        size: 42,
                        messageId: ["one@example.test"],
                        keywords: {},
                      }
                    : { id: "one" },
                ],
              },
              "0",
            ],
          ],
        }),
      );
    },
  });
  expect((await client.migrationEmails(session, "owner", ["one"])).isOk()).toBe(
    true,
  );
  valid = false;
  expect(
    (await client.migrationEmails(session, "owner", ["one"])).isErr(),
  ).toBe(true);
});
