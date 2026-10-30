import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { createSesDomainProvider } from "../src/adapters/domain-ses.ts";

type Scenario =
  | "valid"
  | "identity_missing"
  | "unverified"
  | "token_missing"
  | "dkim_missing"
  | "dkim_unverified"
  | "rule_missing"
  | "wrong_rule_set"
  | "recipient_missing"
  | "disabled";
async function withSes(
  scenario: Scenario,
  work: (
    provider: NonNullable<ReturnType<typeof createSesDomainProvider>>,
    requests: {
      method: string | undefined;
      path: string | undefined;
      action: string | null;
    }[],
  ) => Promise<void>,
) {
  const requests: {
    method: string | undefined;
    path: string | undefined;
    action: string | null;
  }[] = [];
  const listener = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const params = new URLSearchParams(Buffer.concat(chunks).toString());
      const action = params.get("Action");
      requests.push({ method: request.method, path: request.url, action });
      if (request.url?.startsWith("/v2/")) {
        response.setHeader("content-type", "application/json");
        if (scenario === "identity_missing") {
          response.statusCode = 404;
          response.setHeader("x-amzn-errortype", "NotFoundException");
          response.end(JSON.stringify({ message: "not found" }));
          return;
        }
        response.end(
          JSON.stringify({
            DkimAttributes: {
              Tokens: scenario === "dkim_missing" ? [] : ["existing"],
              Status: scenario === "dkim_unverified" ? "PENDING" : "SUCCESS",
            },
            VerifiedForSendingStatus: scenario !== "unverified",
          }),
        );
        return;
      }
      const result =
        action === "GetIdentityVerificationAttributes"
          ? `<VerificationAttributes><entry><key>example.test</key><value>${scenario === "token_missing" ? "" : "<VerificationToken>existing-token</VerificationToken>"}</value></entry></VerificationAttributes>`
          : action === "DescribeActiveReceiptRuleSet"
            ? scenario === "rule_missing"
              ? ""
              : `<Metadata><Name>${scenario === "wrong_rule_set" ? "other" : "active"}</Name></Metadata>`
            : action === "DescribeReceiptRule"
              ? `<Rule><Name>inbound</Name><Enabled>${scenario === "disabled" ? "false" : "true"}</Enabled><Recipients><member>${scenario === "recipient_missing" ? "other.test" : "EXAMPLE.TEST"}</member></Recipients><Actions><member><S3Action><BucketName>buffer</BucketName></S3Action></member></Actions></Rule>`
              : "";
      response.setHeader("content-type", "text/xml");
      response.end(
        `<${action}Response xmlns="http://ses.amazonaws.com/doc/2010-12-01/"><${action}Result>${result}</${action}Result><ResponseMetadata><RequestId>test</RequestId></ResponseMetadata></${action}Response>`,
      );
    });
  });
  await new Promise<void>((resolve) =>
    listener.listen(0, "127.0.0.1", resolve),
  );
  const address = listener.address();
  if (address === null || typeof address === "string")
    throw new Error("missing test port");
  try {
    const provider = createSesDomainProvider({
      enabled: true,
      ruleName: "inbound",
      ruleSetName: "active",
      approvedDomains: ["example.test"],
      endpoint: `http://127.0.0.1:${address.port}`,
      credentials: { accessKeyId: "file-key", secretAccessKey: "file-secret" },
    });
    if (provider === undefined) throw new Error("provider disabled");
    await work(provider, requests);
    expect(
      requests.every(
        (request) =>
          request.method !== "POST" || !request.path?.startsWith("/v2/"),
      ),
    ).toBe(true);
    const unexpected = requests.filter((request) =>
      request.path?.startsWith("/v2/")
        ? request.method !== "GET"
        : ![
            "GetIdentityVerificationAttributes",
            "DescribeActiveReceiptRuleSet",
            "DescribeReceiptRule",
          ].includes(request.action ?? ""),
    );
    expect(unexpected).toEqual([]);
  } finally {
    await new Promise<void>((resolve, reject) =>
      listener.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

describe("read-only SES domain adoption", () => {
  it("adopts an existing verified identity and recipient without SES writes", async () => {
    await withSes("valid", async (provider) => {
      const identity = await provider.ensure("example.test");
      expect(identity.isOk() && identity.value).toEqual({
        verificationToken: "existing-token",
        dkimTokens: ["existing"],
      });
      expect((await provider.receipt("example.test", true)).isOk()).toBe(true);
      expect((await provider.receipt("example.test", false)).isErr()).toBe(
        true,
      );
      expect((await provider.ensure("other.test")).isErr()).toBe(true);
    });
  });
  it.each([
    "identity_missing",
    "unverified",
    "token_missing",
    "dkim_missing",
    "dkim_unverified",
  ] as const)("rejects %s", async (scenario) => {
    await withSes(scenario, async (provider) =>
      expect((await provider.ensure("example.test")).isErr()).toBe(true),
    );
  });
  it.each([
    "rule_missing",
    "wrong_rule_set",
    "recipient_missing",
    "disabled",
  ] as const)("rejects %s", async (scenario) => {
    await withSes(scenario, async (provider) =>
      expect((await provider.receipt("example.test", true)).isErr()).toBe(true),
    );
  });
});
