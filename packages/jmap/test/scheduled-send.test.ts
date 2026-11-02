import { expect, it } from "vitest";
import { JmapClient, JmapCapability, type Session } from "../src/index.ts";

it("keeps a failed post-submission mailbox update ambiguous and tags the submission", async () => {
  const session: Session = {
    capabilities: {},
    accounts: {
      a: {
        name: "a",
        isPersonal: true,
        isReadOnly: false,
        accountCapabilities: {
          [JmapCapability.submission]: { submissionExtensions: { DSN: {} } },
        },
      },
    },
    primaryAccounts: {},
    username: "user",
    apiUrl: "https://mail.example.test/jmap/",
    uploadUrl: "https://mail.example.test/upload/{accountId}",
    downloadUrl:
      "https://mail.example.test/download/{accountId}/{blobId}/{name}",
    state: "s",
  };
  let requestBody = "";
  const fetcher: typeof fetch = (_input, init) => {
    requestBody = typeof init?.body === "string" ? init.body : "";
    return Promise.resolve(
      Response.json({
        methodResponses: [
          [
            "EmailSubmission/set",
            { accountId: "a", created: { item: { id: "submission" } } },
            "0",
          ],
          [
            "Email/set",
            { accountId: "a", notUpdated: { email: { type: "notFound" } } },
            "0",
          ],
        ],
        sessionState: "s",
      }),
    );
  };
  const client = new JmapClient("https://mail.example.test", {
    authorization: "Bearer test",
    fetch: fetcher,
  });
  const result = await client.submit(
    session,
    "a",
    "email",
    "identity",
    {
      mailFrom: { email: "a@example.test" },
      rcptTo: [{ email: "b@example.test" }],
    },
    "sent",
    { requestId: "request-1", uncertainFollowup: true },
  );
  expect(requestBody).toContain('"ENVID":"request-1"');
  expect(result.isErr()).toBe(true);
  expect(result.isErr() ? result.error : undefined).toMatchObject({
    kind: "invalidResponse",
  });
});
