import { describe, expect, it } from "vitest";
import { z } from "zod";
import { StalwartAdmin } from "../src/admin.ts";

const request = z.object({
  methodCalls: z.tuple([z.tuple([z.string(), z.unknown(), z.string()])]),
});
function fixture(
  routeHost: string,
  strategyRoute = "'osrelay'",
  signing: object = { match: {}, else: "false" },
) {
  const fetcher: typeof fetch = (_input, init) => {
    if (typeof init?.body !== "string") throw new Error("missing request body");
    const body = request.parse(JSON.parse(init.body));
    const method = body.methodCalls[0][0];
    let value: object;
    if (method.endsWith("/query"))
      value = { accountId: "a", ids: ["id"], position: 0, queryState: "s" };
    else if (method === "x:MtaRoute/get")
      value = {
        accountId: "a",
        notFound: [],
        list: [
          {
            id: "id",
            name: "osrelay",
            "@type": "Relay",
            host: routeHost,
            port: 2587,
            protocol: "smtp",
            implicitTls: false,
            allowInvalidCerts: false,
            authUsername: "user",
            authSecret: { "@type": "File", filePath: "/secret" },
          },
        ],
      };
    else if (method === "x:MtaStageData/get")
      value = {
        accountId: "a",
        notFound: [],
        list: [{ id: "singleton", dkimSignDomain: signing }],
      };
    else if (method === "x:MtaTlsStrategy/get")
      value = {
        accountId: "a",
        notFound: [],
        list: [
          {
            id: "id",
            name: "osrelay",
            startTls: "require",
            allowInvalidCerts: false,
          },
        ],
      };
    else
      value = {
        accountId: "a",
        notFound: [],
        list: [
          {
            id: "singleton",
            route: {
              match: {
                "0": Object.fromEntries([
                  ["if", "is_local_domain(rcpt_domain)"],
                  [["th", "en"].join(""), "'local'"],
                ]),
              },
              else: strategyRoute,
            },
            tls: { match: {}, else: "'osrelay'" },
          },
        ],
      };
    return Promise.resolve(
      Response.json({
        methodResponses: [[method, value, "0"]],
        sessionState: "s",
      }),
    );
  };
  return new StalwartAdmin(
    "http://localhost",
    { username: "admin", password: "secret" },
    { fetch: fetcher },
  );
}
describe("SES relay inspection", () => {
  it("checks route, TLS and active strategy without returning credentials", async () => {
    const configured = await fixture(
      "email-smtp.eu-north-1.amazonaws.com",
    ).sesRelayConfigured();
    const wrongHost = await fixture("other.example").sesRelayConfigured();
    const wrongStrategy = await fixture(
      "email-smtp.eu-north-1.amazonaws.com",
      "'mx'",
    ).sesRelayConfigured();
    expect(configured.isOk() && configured.value).toBe(true);
    expect(wrongHost.isOk() && wrongHost.value).toBe(false);
    expect(wrongStrategy.isOk() && wrongStrategy.value).toBe(false);
    // Stalwart still signing would make SES refuse the message.
    const signing = await fixture(
      "email-smtp.eu-north-1.amazonaws.com",
      "'osrelay'",
      { match: {}, else: "sender_domain" },
    ).sesRelayConfigured();
    expect(signing.isOk() && signing.value).toBe(false);
  });
});
