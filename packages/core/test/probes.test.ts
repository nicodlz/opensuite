import { S3Client } from "@aws-sdk/client-s3";
import { SQSClient } from "@aws-sdk/client-sqs";
import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { bucketProbe, httpProbe, queueProbe } from "../src/services/probes.ts";

const server = createServer((request, response) => {
  if (request.url === "/healthy") response.writeHead(200).end();
  else if (request.url?.includes("bucket")) response.writeHead(403).end();
  else
    response
      .writeHead(200, { "content-type": "application/x-amz-json-1.0" })
      .end(JSON.stringify({ Attributes: { QueueArn: "arn:test" } }));
});
const listen = async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("no port");
  return `http://127.0.0.1:${String(address.port)}`;
};
afterEach(async () => {
  if (server.listening)
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
});

describe("dependency adapters", () => {
  it("probes Stalwart HTTP status without following redirects", async () => {
    const origin = await listen();
    expect(
      (
        await httpProbe("mail", `${origin}/healthy`).check(
          AbortSignal.timeout(1000),
        )
      ).isOk(),
    ).toBe(true);
    expect(
      (
        await httpProbe("mail", `${origin}/bucket`).check(
          AbortSignal.timeout(1000),
        )
      ).isErr(),
    ).toBe(true);
  });
  it("checks bucket permissions and queue attributes, with safe errors", async () => {
    const origin = await listen();
    const config = {
      endpoint: origin,
      region: "us-east-1",
      credentials: { accessKeyId: "fake", secretAccessKey: "fake" },
      maxAttempts: 1,
    };
    const s3 = new S3Client({ ...config, forcePathStyle: true });
    const sqs = new SQSClient(config);
    const bucket = await bucketProbe("storage", s3, "bucket").check(
      AbortSignal.timeout(2000),
    );
    expect(bucket.isErr()).toBe(true);
    expect(
      bucket.match(
        () => "unexpected success",
        (error) => error.message,
      ),
    ).toBe("dependency check failed");
    expect(
      (
        await queueProbe(sqs, `${origin}/queue`).check(
          AbortSignal.timeout(2000),
        )
      ).isOk(),
    ).toBe(true);
    s3.destroy();
    sqs.destroy();
  });
});
