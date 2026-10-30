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
    let identityExists = false;
    const listener = createServer(
      (request: IncomingMessage, response: ServerResponse) => {
        const chunks: Buffer[] = [];
        request.on("data", (chunk: Buffer) => chunks.push(chunk));
        request.on("end", () => {
          if (request.url?.startsWith("/v2/")) {
            response.setHeader("content-type", "application/json");
            if (request.method === "GET" && !identityExists) {
              response.statusCode = 404;
              response.setHeader("x-amzn-errortype", "NotFoundException");
              response.end(JSON.stringify({ message: "not found" }));
              return;
            }
            if (request.method === "POST") identityExists = true;
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
  it("adopts an existing identity and recipient without recreating or updating either", async () => {
    const requests: {
      method: string | undefined;
      url: string | undefined;
      action: string | null;
      authorization: string | undefined;
    }[] = [];
    const listener = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const params = new URLSearchParams(Buffer.concat(chunks).toString());
        const action = params.get("Action");
        requests.push({
          method: request.method,
          url: request.url,
          action,
          authorization: request.headers.authorization,
        });
        if (request.url?.startsWith("/v2/")) {
          response.setHeader("content-type", "application/json");
          response.end(
            JSON.stringify({
              DkimAttributes: { Tokens: ["existing"] },
              VerifiedForSendingStatus: true,
            }),
          );
          return;
        }
        const result =
          action === "VerifyDomainIdentity"
            ? "<VerificationToken>existing-token</VerificationToken>"
            : action === "DescribeActiveReceiptRuleSet"
              ? "<Metadata><Name>active</Name></Metadata>"
              : action === "DescribeReceiptRule"
                ? "<Rule><Name>inbound</Name><Enabled>true</Enabled><Recipients><member>EXAMPLE.TEST</member></Recipients><Actions><member><S3Action><BucketName>buffer</BucketName></S3Action></member></Actions></Rule>"
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
        endpoint: `http://127.0.0.1:${address.port}`,
        credentials: {
          accessKeyId: "file-key",
          secretAccessKey: "file-secret",
        },
      });
      if (provider === undefined) throw new Error("provider disabled");
      const identity = await provider.ensure("example.test");
      expect(identity.isOk() && identity.value).toEqual({
        verificationToken: "existing-token",
        dkimTokens: ["existing"],
      });
      expect((await provider.receipt("example.test", true)).isOk()).toBe(true);
      const verified = await provider.verified("example.test");
      expect(verified.isOk() && verified.value).toBe(true);
      expect(
        requests.filter(
          (request) =>
            request.url?.startsWith("/v2/") && request.method === "POST",
        ),
      ).toHaveLength(0);
      expect(
        requests.filter((request) => request.action === "UpdateReceiptRule"),
      ).toHaveLength(0);
      expect(
        requests.some((request) => request.action === "DescribeReceiptRule"),
      ).toBe(true);
      expect(
        requests.every((request) =>
          request.authorization?.includes("Credential=file-key/"),
        ),
      ).toBe(true);
    } finally {
      await new Promise<void>((resolve, reject) =>
        listener.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
