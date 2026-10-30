import { describe, expect, it } from "vitest";
import { JmapClient, type Session } from "../src/index.ts";

const session: Session = {
  capabilities: {},
  accounts: {},
  primaryAccounts: {},
  username: "user",
  apiUrl: "https://mail.example.test/jmap/",
  uploadUrl: "https://mail.example.test/upload/{accountId}",
  downloadUrl:
    "https://mail.example.test/download/{accountId}/{blobId}/{name}?accept={type}",
  state: "a",
};
const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
const clientWith = (reply: Response) =>
  new JmapClient("https://mail.example.test", {
    authorization: "Bearer test",
    fetch: async () => Promise.resolve(reply),
  });
const errorOf = (result: { isErr(): boolean; error?: unknown }) =>
  result.isErr() ? result.error : undefined;

const failingFetch: typeof fetch = async () =>
  Promise.reject(new Error("offline"));

describe("JMAP errors", () => {
  it("reports HTTP and request-level problems", async () => {
    const http = await clientWith(
      new Response("unavailable", { status: 503 }),
    ).discover();
    expect(errorOf(http)).toMatchObject({ kind: "http", status: 503 });
    const problem = await clientWith(
      response(
        { type: "urn:ietf:params:jmap:error:limit", description: "large" },
        400,
      ),
    ).discover();
    expect(errorOf(problem)).toMatchObject({
      kind: "request",
      status: 400,
      type: "urn:ietf:params:jmap:error:limit",
    });
  });
  it("reports method and item errors", async () => {
    const method = await clientWith(
      response({
        methodResponses: [["error", { type: "invalidArguments" }, "0"]],
        sessionState: "a",
      }),
    ).mailboxes(session, "a");
    expect(errorOf(method)).toMatchObject({
      kind: "method",
      method: "Mailbox/get",
      type: "invalidArguments",
    });
    const item = await clientWith(
      response({
        methodResponses: [
          [
            "Email/import",
            { accountId: "a", notCreated: { item: { type: "blobNotFound" } } },
            "0",
          ],
        ],
        sessionState: "a",
      }),
    ).importEmail(session, "a", {
      blobId: "missing",
      mailboxIds: { inbox: true },
    });
    expect(errorOf(item)).toMatchObject({
      kind: "set",
      method: "Email/import",
      type: "blobNotFound",
    });
  });
  it("rejects malformed responses and unexpected response IDs", async () => {
    const invalid = await clientWith(response({ accounts: {} })).discover();
    expect(errorOf(invalid)).toMatchObject({ kind: "invalidResponse" });
    const wrongId = await clientWith(
      response({
        methodResponses: [
          [
            "Mailbox/get",
            { accountId: "a", state: "a", list: [], notFound: [] },
            "wrong",
          ],
        ],
        sessionState: "a",
      }),
    ).mailboxes(session, "a");
    expect(errorOf(wrongId)).toMatchObject({ kind: "invalidResponse" });
  });
  it("reports network failures and invalid JSON", async () => {
    const client = new JmapClient("https://mail.example.test", {
      authorization: "Bearer test",
      fetch: failingFetch,
    });
    expect(errorOf(await client.discover())).toMatchObject({
      kind: "network",
      message: "offline",
    });
    expect(
      errorOf(await clientWith(new Response("not json")).discover()),
    ).toMatchObject({ kind: "invalidResponse" });
  });
  it("does not send authorization to a different advertised origin", async () => {
    let called = false;
    const client = new JmapClient("https://mail.example.test", {
      authorization: "Bearer test",
      fetch: async () => {
        called = true;
        return Promise.resolve(response({}));
      },
    });
    const result = await client.mailboxes(
      { ...session, apiUrl: "https://other.example.test/jmap/" },
      "a",
    );
    expect(errorOf(result)).toMatchObject({ kind: "invalidResponse" });
    expect(called).toBe(false);
  });
});

const submissionReply = (notUpdated: object | null) =>
  response({
    methodResponses: [
      [
        "EmailSubmission/set",
        { accountId: "a", created: { item: { id: "submission" } } },
        "0",
      ],
      [
        "Email/set",
        {
          accountId: "a",
          updated: notUpdated ? null : { email: null },
          notUpdated,
        },
        "0",
      ],
    ],
    sessionState: "s",
  });

it("accepts and checks the follow-up update returned by submission", async () => {
  expect(
    (
      await clientWith(submissionReply(null)).submit(
        session,
        "a",
        "email",
        "identity",
        undefined,
        "sent",
      )
    ).isOk(),
  ).toBe(true);
  const failed = await clientWith(
    submissionReply({ email: { type: "forbidden" } }),
  ).submit(session, "a", "email", "identity", undefined, "sent");
  expect(errorOf(failed)).toMatchObject({
    kind: "set",
    method: "Email/set",
    type: "forbidden",
  });
});
