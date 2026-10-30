import { describe, expect, it } from "vitest";
import { StalwartAdmin } from "../src/admin.ts";

const valid = {
  host: "email-smtp.eu-north-1.amazonaws.com",
  port: 2587,
  username: "fixture-user",
  secretFile: "/run/opensuite/smtp-secret",
  tls: "starttls",
};

describe("outbound management errors", () => {
  it("rejects invalid input before contacting the server", async () => {
    let requests = 0;
    const admin = new StalwartAdmin(
      "http://localhost",
      { username: "admin", password: "test" },
      {
        fetch: async () => {
          requests++;
          return Promise.reject(new Error("unexpected"));
        },
      },
    );
    const result = await admin.configureRelay({ ...valid, port: 0 });
    expect(result.isErr() && result.error.kind).toBe("invalidInput");
    expect(requests).toBe(0);
  });
  it("returns a management failure instead of reporting success", async () => {
    const admin = new StalwartAdmin(
      "http://localhost",
      { username: "admin", password: "test" },
      {
        fetch: async () =>
          Promise.resolve(
            new Response(
              JSON.stringify({
                methodResponses: [
                  [
                    "error",
                    { type: "forbidden", description: "permission denied" },
                    "0",
                  ],
                ],
                sessionState: "s",
              }),
              { status: 200 },
            ),
          ),
      },
    );
    const result = await admin.configureRelay(valid);
    expect(result.isErr() && result.error).toMatchObject({
      kind: "method",
      method: "x:MtaStageData/get",
      type: "forbidden",
    });
  });
});

it("treats an explicitly missing account as already detached", async () => {
  const admin = new StalwartAdmin(
    "http://localhost",
    { username: "admin", password: "test" },
    {
      fetch: () =>
        Promise.resolve(
          Response.json({
            methodResponses: [
              [
                "x:Account/get",
                { accountId: "manager", list: [], notFound: ["gone"] },
                "0",
              ],
            ],
            sessionState: "s",
          }),
        ),
    },
  );
  expect((await admin.removeAlias("gone", "alias", "domain")).isOk()).toBe(
    true,
  );
  expect((await admin.removeAlias("other", "alias", "domain")).isErr()).toBe(
    true,
  );
});
