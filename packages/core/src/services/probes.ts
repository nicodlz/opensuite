import { HeadBucketCommand, type S3Client } from "@aws-sdk/client-s3";
import { GetQueueAttributesCommand, type SQSClient } from "@aws-sdk/client-sqs";
import { ResultAsync } from "neverthrow";
import type { DependencyProbe } from "./readiness.ts";

/** Probes only report a fixed error: SDK errors may contain credentials or URLs. */
export const probe = (
  name: string,
  check: (signal: AbortSignal) => Promise<unknown>,
): DependencyProbe => ({
  name,
  check: (signal) =>
    ResultAsync.fromPromise(
      Promise.resolve()
        .then(() => check(signal))
        .then(() => undefined),
      () => ({ kind: "unavailable", message: "dependency check failed" }),
    ),
});

export const httpProbe = (name: string, url: string): DependencyProbe =>
  probe(name, async (signal) => {
    const response = await fetch(url, { signal, redirect: "error" });
    if (!response.ok) throw new Error("unavailable");
  });

export const bucketProbe = (name: string, client: S3Client, bucket: string) =>
  probe(name, (signal) =>
    client.send(new HeadBucketCommand({ Bucket: bucket }), {
      abortSignal: signal,
    }),
  );

export const queueProbe = (client: SQSClient, url: string) =>
  probe("queue", (signal) =>
    client.send(
      new GetQueueAttributesCommand({
        QueueUrl: url,
        AttributeNames: ["QueueArn"],
      }),
      { abortSignal: signal },
    ),
  );
