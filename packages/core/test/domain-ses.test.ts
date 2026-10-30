import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSesDomainProvider } from "../src/adapters/domain-ses.ts";

describe("SES domain adapter with a local fake", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("creates identities and preserves receipt-rule actions while restricting recipients", async () => {
    vi.stubEnv("AWS_ACCESS_KEY_ID", "local");
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", "local");
    const requests: URLSearchParams[] = [];
    const listener = createServer(
      (request: IncomingMessage, response: ServerResponse) => {
        const chunks: Buffer[] = [];
        request.on("data", (chunk: Buffer) => chunks.push(chunk));
        request.on("end", () => {
          if (request.url?.startsWith("/v2/")) {
            response.setHeader("content-type", "application/json");
            response.end(
              JSON.stringify({
                DkimAttributes: { Tokens: ["selector"] },
                VerifiedForSendingStatus: true,
              }),
            );
            return;
          }
          const params = new URLSearchParams(Buffer.concat(chunks).toString());
          requests.push(params);
          const action = params.get("Action");
          const result =
            action === "VerifyDomainIdentity"
              ? "<VerificationToken>token</VerificationToken>"
              : action === "DescribeActiveReceiptRuleSet"
                ? "<Metadata><Name>active</Name></Metadata>"
                : action === "DescribeReceiptRule"
                  ? "<Rule><Name>inbound</Name><Enabled>true</Enabled><Recipients><member>existing.example</member></Recipients><Actions><member><S3Action><BucketName>buffer</BucketName></S3Action></member></Actions></Rule>"
                  : "";
          response.setHeader("content-type", "text/xml");
          response.end(
            `<${action}Response xmlns="http://ses.amazonaws.com/doc/2010-12-01/"><${action}Result>${result}</${action}Result><ResponseMetadata><RequestId>test</RequestId></ResponseMetadata></${action}Response>`,
          );
        });
      },
    );
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
        endpoint: `http://127.0.0.1:${address.port}`,
      });
      if (provider === undefined) throw new Error("provider disabled");
      const identity = await provider.ensure("example.test");
      expect(identity.isOk() && identity.value).toEqual({
        verificationToken: "token",
        dkimTokens: ["selector"],
      });
      expect((await provider.verified("example.test")).isOk()).toBe(true);
      expect((await provider.receipt("example.test", true)).isOk()).toBe(true);
      const update = requests.find(
        (request) => request.get("Action") === "UpdateReceiptRule",
      );
      expect([...(update?.values() ?? [])]).toEqual(
        expect.arrayContaining(["existing.example", "example.test", "buffer"]),
      );
      expect((await provider.receipt("existing.example", false)).isErr()).toBe(
        true,
      );
      expect(
        requests.filter(
          (request) => request.get("Action") === "UpdateReceiptRule",
        ),
      ).toHaveLength(1);
    } finally {
      await new Promise<void>((resolve, reject) =>
        listener.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
