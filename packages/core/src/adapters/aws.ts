import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  type SQSClient,
} from "@aws-sdk/client-sqs";
import { ResultAsync } from "neverthrow";
import { z } from "zod";
import type { Queue, Storage } from "../ingest/contracts.ts";

const failure = (cause: unknown) => ({
  message: cause instanceof Error ? cause.message : String(cause),
});
const queueResponse = z
  .object({
    Messages: z
      .array(
        z.object({
          Body: z.string().min(1),
          ReceiptHandle: z.string().min(1),
          Attributes: z
            .object({ ApproximateReceiveCount: z.string().regex(/^\d+$/) })
            .passthrough(),
        }),
      )
      .optional(),
  })
  .passthrough();
const listResponse = z
  .object({
    Contents: z
      .array(z.object({ Key: z.string().min(1) }).passthrough())
      .optional(),
    IsTruncated: z.boolean().optional(),
    NextContinuationToken: z.string().optional(),
  })
  .passthrough();
export function awsQueue(client: SQSClient, url: string): Queue {
  return {
    receive() {
      return ResultAsync.fromPromise(
        client
          .send(
            new ReceiveMessageCommand({
              QueueUrl: url,
              MaxNumberOfMessages: 1,
              WaitTimeSeconds: 20,
              VisibilityTimeout: 300,
              MessageSystemAttributeNames: ["ApproximateReceiveCount"],
            }),
          )
          .then((response) =>
            (queueResponse.parse(response).Messages ?? []).map((m) => ({
              body: m.Body,
              receipt: m.ReceiptHandle,
              attempts: Number(m.Attributes.ApproximateReceiveCount),
            })),
          ),
        failure,
      );
    },
    delete(receipt) {
      return ResultAsync.fromPromise(
        client
          .send(
            new DeleteMessageCommand({ QueueUrl: url, ReceiptHandle: receipt }),
          )
          .then(() => undefined),
        failure,
      );
    },
    defer(receipt, seconds) {
      return ResultAsync.fromPromise(
        client
          .send(
            new ChangeMessageVisibilityCommand({
              QueueUrl: url,
              ReceiptHandle: receipt,
              VisibilityTimeout: seconds,
            }),
          )
          .then(() => undefined),
        failure,
      );
    },
  };
}
const list = async (
  client: S3Client,
  name: string,
  path: string,
): Promise<string[]> => {
  const page = async (token?: string): Promise<string[]> => {
    const response = listResponse.parse(
      await client.send(
        new ListObjectsV2Command({
          Bucket: name,
          Prefix: path,
          ContinuationToken: token,
        }),
      ),
    );
    const keys = (response.Contents ?? []).map((item) => item.Key);
    if (response.IsTruncated !== true) return keys;
    if (response.NextContinuationToken === undefined)
      throw new Error("Truncated S3 response has no continuation token");
    return [...keys, ...(await page(response.NextContinuationToken))];
  };
  return page();
};
const read = async (client: S3Client, name: string, key: string) => {
  const signal = AbortSignal.timeout(120_000);
  const response = await client.send(
    new GetObjectCommand({ Bucket: name, Key: key }),
    { abortSignal: signal },
  );
  if (response.Body === undefined) throw new Error("Missing S3 object body");
  const body = response.Body;
  const stop = () => {
    if ("destroy" in body && typeof body.destroy === "function")
      body.destroy(new Error("S3 body timed out"));
  };
  if (signal.aborted) {
    stop();
    throw new Error("S3 body timed out");
  }
  signal.addEventListener("abort", stop, { once: true });
  try {
    return await body.transformToByteArray();
  } finally {
    signal.removeEventListener("abort", stop);
  }
};

export function awsStorage(
  buffer: S3Client,
  archive: S3Client,
  bucket: string,
  archiveBucket: string,
  prefix: string,
  bufferPrefix: string,
): Storage {
  return {
    archive(key, body) {
      return ResultAsync.fromPromise(
        archive
          .send(
            new PutObjectCommand({
              Bucket: archiveBucket,
              Key: prefix + key,
              Body: body,
              ContentType: "application/json",
            }),
          )
          .then(() => undefined),
        failure,
      );
    },
    readArchive(key) {
      return ResultAsync.fromPromise(
        read(archive, archiveBucket, key).then((bytes) =>
          new TextDecoder().decode(bytes),
        ),
        failure,
      );
    },
    archives() {
      return ResultAsync.fromPromise(
        list(archive, archiveBucket, prefix),
        failure,
      );
    },
    bufferKeys() {
      return ResultAsync.fromPromise(
        list(buffer, bucket, bufferPrefix),
        failure,
      );
    },
    readBuffer(name, key) {
      return ResultAsync.fromPromise(read(buffer, name, key), failure);
    },
    deleteBuffer(name, key) {
      return ResultAsync.fromPromise(
        buffer
          .send(new DeleteObjectCommand({ Bucket: name, Key: key }))
          .then(() => undefined),
        failure,
      );
    },
  };
}
