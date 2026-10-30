import { S3Client } from "@aws-sdk/client-s3";
import { createServer } from "node:http";
import { expect, it } from "vitest";
import { copyVerifiedObject } from "../src/adapters/copy.ts";

it("copies large verified objects in conditional parts and aborts on a changed source", async () => {
  const requests: {
    method: string;
    url: string;
    headers: Record<string, string | string[] | undefined>;
  }[] = [];
  let rejectPart = false;
  const server = createServer((req, res) => {
    const url = req.url ?? "";
    requests.push({ method: req.method ?? "", url, headers: req.headers });
    res.setHeader("content-type", "application/xml");
    if (url.includes("uploads")) {
      res.end(
        "<InitiateMultipartUploadResult><UploadId>copy-id</UploadId></InitiateMultipartUploadResult>",
      );
    } else if (url.includes("partNumber=")) {
      if (rejectPart) {
        res.statusCode = 412;
        res.end("<Error><Code>PreconditionFailed</Code></Error>");
      } else {
        res.end('<CopyPartResult><ETag>"part-etag"</ETag></CopyPartResult>');
      }
    } else if (req.method === "DELETE") {
      res.statusCode = 204;
      res.end();
    } else if (url.includes("uploadId=")) {
      res.end(
        "<CompleteMultipartUploadResult><ETag>complete</ETag></CompleteMultipartUploadResult>",
      );
    } else {
      res.end("<CopyObjectResult><ETag>copy</ETag></CopyObjectResult>");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("missing address");
  const client = new S3Client({
    endpoint: `http://127.0.0.1:${address.port}`,
    region: "us-east-1",
    forcePathStyle: true,
    credentials: { accessKeyId: "test", secretAccessKey: "test" },
    maxAttempts: 1,
  });
  try {
    await copyVerifiedObject(
      client,
      "bucket",
      "pending/file",
      "objects/file",
      5_000_000_001,
      '"verified"',
      "application/octet-stream",
    );
    const parts = requests.filter((r) => r.url.includes("partNumber="));
    expect(parts).toHaveLength(10);
    expect(parts[0]?.headers["x-amz-copy-source-range"]).toBe(
      "bytes=0-536870911",
    );
    expect(parts.at(-1)?.headers["x-amz-copy-source-range"]).toBe(
      "bytes=4831838208-5000000000",
    );
    expect(
      parts.every(
        (r) => r.headers["x-amz-copy-source-if-match"] === '"verified"',
      ),
    ).toBe(true);
    expect(requests.at(-1)?.url).toContain("uploadId=copy-id");
    expect(requests.at(-1)?.method).toBe("POST");
    expect(requests[0]?.headers["content-disposition"]).toBe("attachment");
    requests.length = 0;
    rejectPart = true;
    await expect(
      copyVerifiedObject(
        client,
        "bucket",
        "pending/file",
        "objects/file",
        5_000_000_001,
        '"verified"',
        "application/octet-stream",
      ),
    ).rejects.toThrow("UnknownError");
    expect(requests.at(-1)?.method).toBe("DELETE");
    expect(requests.at(-1)?.url).toContain("uploadId=copy-id");
    requests.length = 0;
    await copyVerifiedObject(
      client,
      "bucket",
      "pending/file",
      "objects/file",
      5_000_000_000,
      '"verified"',
      "application/octet-stream",
    );
    expect(requests).toHaveLength(1);
    expect(requests[0]?.headers["x-amz-copy-source-if-match"]).toBe(
      '"verified"',
    );
  } finally {
    client.destroy();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
