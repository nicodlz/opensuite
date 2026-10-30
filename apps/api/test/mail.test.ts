import { createReadinessService } from "@opensuite/core";
import { createMailService } from "@opensuite/core/services/mail";
import { JmapClient } from "@opensuite/jmap";
import { err, ok } from "neverthrow";
import { describe, expect, it } from "vitest";
import { buildServer } from "../src/server.ts";

const origin = "https://mail.example.test";
const fakeFetch: typeof fetch = (url, init) => {
  if (init?.method === "POST")
    return Promise.resolve(
      Response.json({
        methodResponses: [
          [
            "Mailbox/get",
            {
              accountId: "jmap",
              state: "s",
              list: [
                {
                  id: "inbox-id",
                  name: "Inbox",
                  role: "inbox",
                  parentId: null,
                  totalEmails: 1,
                  unreadEmails: 1,
                },
              ],
              notFound: [],
            },
            "0",
          ],
        ],
        sessionState: "s",
      }),
    );
  if (
    (url instanceof Request ? url.url : url.toString()).includes("/download/")
  )
    return Promise.resolve(new Response("private attachment"));
  return Promise.resolve(
    Response.json({
      capabilities: {},
      accounts: {},
      primaryAccounts: { "urn:ietf:params:jmap:mail": "jmap" },
      username: "owner",
      apiUrl: `${origin}/jmap`,
      uploadUrl: `${origin}/upload/{accountId}`,
      downloadUrl: `${origin}/download/{accountId}/{blobId}/{name}?type={type}`,
      state: "s",
    }),
  );
};
const mail = createMailService({
  origin,
  store: {
    getForOwner: (userId, accountId) =>
      Promise.resolve(
        userId === "owner" && accountId === "default"
          ? ok({
              accountId: "owned",
              address: "owner@example.test",
              secret: "private-password",
            })
          : err({ kind: "not_found" }),
      ),
  },
  client: () =>
    new JmapClient(origin, { authorization: "secret", fetch: fakeFetch }),
});
const now = () => performance.now();
const start = () =>
  buildServer({
    config: { logLevel: "silent" },
    monotonicMs: now,
    readiness: createReadinessService({
      probes: [],
      timeoutMs: 500,
      now: () => new Date(),
      monotonicMs: now,
    }),
    mail,
    identity: {
      publicOrigin: "https://suite.example.test",
      handler: () => Promise.resolve(new Response()),
      actor: (headers) => {
        const id = headers.get("cookie");
        return Promise.resolve(
          id === "owner" || id === "other"
            ? { id, email: `${id}@example.test`, role: "user" }
            : null,
        );
      },
    },
  });
const headers = { origin: "https://suite.example.test", cookie: "owner" };
describe("mail API session authorization", () => {
  it("requires a session and enforces account ownership without exposing credentials", async () => {
    const app = await start();
    try {
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/mail/mailboxes",
            headers: { origin: headers.origin },
            payload: { accountId: "default" },
          })
        ).statusCode,
      ).toBe(401);
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/mail/mailboxes",
            headers: { ...headers, cookie: "other" },
            payload: { accountId: "default" },
          })
        ).statusCode,
      ).toBe(403);
      const response = await app.inject({
        method: "POST",
        url: "/mail/mailboxes",
        headers,
        payload: { accountId: "default" },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        mailboxes: [{ id: "inbox-id", total: 1, unread: 1 }],
      });
      expect(response.body).not.toContain("private-password");
    } finally {
      await app.close();
    }
  });
  it("limits ordinary bodies and checks upload origin and session before parsing", async () => {
    const app = await start();
    try {
      const big = JSON.stringify({
        accountId: "default",
        base64: "A".repeat(1_010_000),
        name: "file",
        type: "text/plain",
      });
      const content = { "content-type": "application/json" };
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/mail/mailboxes",
            headers: { ...content, ...headers },
            payload: big,
          })
        ).statusCode,
      ).toBe(413);
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/mail/attachments/upload",
            headers: { ...content, origin: "https://wrong.test" },
            payload: "{",
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/mail/attachments/upload",
            headers: { ...content, origin: headers.origin },
            payload: "{",
          })
        ).statusCode,
      ).toBe(401);
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/mail/attachments/upload",
            headers: { ...content, ...headers },
            payload: big,
          })
        ).statusCode,
      ).not.toBe(413);
    } finally {
      await app.close();
    }
  });
  it("requires the same authenticated user to redeem an expiring download", async () => {
    const app = await start();
    try {
      const response = await app.inject({
        method: "POST",
        url: "/mail/attachments/download",
        headers,
        payload: { accountId: "default", blobId: "blob" },
      });
      expect(response.statusCode).toBe(200);
      const data = response.json<{ url: string }>();
      const path = new URL(data.url).pathname.replace(/^\/api/, "");
      expect((await app.inject({ method: "GET", url: path })).statusCode).toBe(
        401,
      );
      expect(
        (
          await app.inject({
            method: "GET",
            url: path,
            headers: { cookie: "other" },
          })
        ).statusCode,
      ).toBe(403);
      const download = await app.inject({
        method: "GET",
        url: path,
        headers: { cookie: "owner" },
      });
      expect(download.body).toBe("private attachment");
      expect(download.headers["cache-control"]).toBe("private, no-store");
      const issued = await app.inject({
        method: "POST",
        url: "/mail/attachments/download",
        headers,
        payload: { accountId: "default", blobId: "blob" },
      });
      const concurrentPath = new URL(
        issued.json<{ url: string }>().url,
      ).pathname.replace(/^\/api/, "");
      const attempts = await Promise.all(
        [1, 2].map(() =>
          app.inject({
            method: "GET",
            url: concurrentPath,
            headers: { cookie: "owner" },
          }),
        ),
      );
      expect(
        attempts.map((item) => item.statusCode).toSorted((a, b) => a - b),
      ).toEqual([200, 404]);
      expect(
        (
          await app.inject({
            method: "GET",
            url: path,
            headers: { cookie: "owner" },
          })
        ).statusCode,
      ).toBe(404);
    } finally {
      await app.close();
    }
  });
});
