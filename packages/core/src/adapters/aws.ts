import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectVersionsCommand,
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
import type { Queue, RecoveryStore, Storage } from "../ingest/contracts.ts";
import { namedAfter } from "../ingest/recovery.ts";

const failure = (cause: unknown) => ({
  message: cause instanceof Error ? cause.message : String(cause),
  // Only a plain error name is kept, whatever the S3-compatible provider.
  ...(cause instanceof Error
    ? { code: /^[\w.-]{1,64}$/.test(cause.name) ? cause.name : "unknown" }
    : {}),
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
    receive(signal) {
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
            signal === undefined ? {} : { abortSignal: signal },
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

const statusOf = (cause: unknown) => {
  const parsed = z
    .object({ $metadata: z.object({ httpStatusCode: z.number().optional() }) })
    .safeParse(cause);
  return parsed.success ? parsed.data.$metadata.httpStatusCode : undefined;
};
const exists = async (client: S3Client, name: string, key: string) => {
  try {
    await client.send(new HeadObjectCommand({ Bucket: name, Key: key }));
    return true;
  } catch (cause) {
    if (statusOf(cause) === 404) return false;
    throw cause;
  }
};
// A failed precondition means the destination already exists; a conflict
// (409) means a concurrent conditional write and stays an error to retry.
const unlessPresent = async <T>(write: () => Promise<T>) => {
  try {
    await write();
    return true;
  } catch (cause) {
    if (statusOf(cause) === 412) return false;
    throw cause;
  }
};
const firehosePage = z
  .object({
    Contents: z
      .array(
        z
          .object({ Key: z.string().min(1), LastModified: z.date() })
          .passthrough(),
      )
      .optional(),
    IsTruncated: z.boolean().optional(),
    NextContinuationToken: z.string().optional(),
  })
  .passthrough();
const versionPage = z
  .object({
    Versions: z
      .array(
        z
          .object({
            Key: z.string(),
            VersionId: z.string().min(1),
            LastModified: z.date(),
          })
          .passthrough(),
      )
      .optional(),
    IsTruncated: z.boolean().optional(),
    NextKeyMarker: z.string().optional(),
    NextVersionIdMarker: z.string().optional(),
  })
  .passthrough();

// Another writer's different content found where this run wrote.
const archiveChanged = () =>
  Object.assign(
    new Error("Archive entry holds content another writer stored"),
    { name: "ArchiveChanged" },
  );
/** Recovery reads Firehose output in the buffer and restores its versions. */
export function awsRecovery(
  buffer: S3Client,
  archive: S3Client,
  bucket: string,
  archiveBucket: string,
  prefix: string,
): RecoveryStore {
  const archiveVersions = async (key: string) => {
    const response = versionPage.parse(
      await archive.send(
        new ListObjectVersionsCommand({ Bucket: archiveBucket, Prefix: key }),
      ),
    );
    if (response.IsTruncated === true)
      throw new Error("Too many archive entry versions to check");
    return (response.Versions ?? [])
      .filter((item) => item.Key === key)
      .map((item) => item.VersionId);
  };
  return {
    firehoseObjects(path) {
      const page = async (
        token?: string,
      ): Promise<{ key: string; modified: Date }[]> => {
        const response = firehosePage.parse(
          await buffer.send(
            new ListObjectsV2Command({
              Bucket: bucket,
              Prefix: path,
              ContinuationToken: token,
            }),
          ),
        );
        const items = (response.Contents ?? []).map((item) => ({
          key: item.Key,
          modified: item.LastModified,
        }));
        if (response.IsTruncated !== true) return items;
        if (response.NextContinuationToken === undefined)
          throw new Error("Truncated S3 response has no continuation token");
        return [...items, ...(await page(response.NextContinuationToken))];
      };
      return ResultAsync.fromPromise(page(), failure);
    },
    readFirehose(key) {
      return ResultAsync.fromPromise(read(buffer, bucket, key), failure);
    },
    archiveState(key) {
      return ResultAsync.fromPromise(
        (async () => {
          if (!(await exists(archive, archiveBucket, prefix + key)))
            return "absent" as const;
          const stored = new TextDecoder().decode(
            await read(archive, archiveBucket, prefix + key),
          );
          return namedAfter(key, stored)
            ? ("present" as const)
            : ("changed" as const);
        })(),
        failure,
      );
    },
    archiveIfAbsent(key, body, options) {
      const write = (condition: boolean) =>
        archive.send(
          new PutObjectCommand({
            Bucket: archiveBucket,
            Key: prefix + key,
            Body: body,
            ContentType: "application/json",
            ...(condition ? { IfNoneMatch: "*" } : {}),
          }),
        );
      return ResultAsync.fromPromise(
        (async () => {
          try {
            return (await unlessPresent(() => write(true)))
              ? ("written" as const)
              : ("present" as const);
          } catch (cause) {
            // B2 answers 501 to If-None-Match. Without a conditional write,
            // only a fenced run (no other writer) may check, then write an
            // absent entry and verify every stored version.
            if (statusOf(cause) !== 501 || options?.fenced !== true)
              throw cause;
          }
          if (await exists(archive, archiveBucket, prefix + key)) {
            const stored = new TextDecoder().decode(
              await read(archive, archiveBucket, prefix + key),
            );
            if (stored !== body) throw archiveChanged();
            return "present" as const;
          }
          await write(false);
          const stored = new TextDecoder().decode(
            await read(archive, archiveBucket, prefix + key),
          );
          if (stored !== body) throw archiveChanged();
          // Another writer may have created the entry between the check and
          // the write: B2 keeps its version, which must hold the same text.
          const versions = await archiveVersions(prefix + key);
          await Promise.all(
            versions.map(async (versionId) => {
              const version = await archive.send(
                new GetObjectCommand({
                  Bucket: archiveBucket,
                  Key: prefix + key,
                  VersionId: versionId,
                }),
              );
              const text =
                version.Body === undefined
                  ? ""
                  : new TextDecoder().decode(
                      await version.Body.transformToByteArray(),
                    );
              if (text !== body) throw archiveChanged();
            }),
          );
          return "written" as const;
        })(),
        failure,
      );
    },
    bufferExists(name, key) {
      return ResultAsync.fromPromise(exists(buffer, name, key), failure);
    },
    latestVersion(name, key) {
      const page = async (marker?: {
        key: string;
        version: string;
      }): Promise<{ id: string; modified: Date }[]> => {
        const response = versionPage.parse(
          await buffer.send(
            new ListObjectVersionsCommand({
              Bucket: name,
              Prefix: key,
              ...(marker === undefined
                ? {}
                : { KeyMarker: marker.key, VersionIdMarker: marker.version }),
            }),
          ),
        );
        const versions = (response.Versions ?? [])
          .filter((item) => item.Key === key)
          .map((item) => ({ id: item.VersionId, modified: item.LastModified }));
        if (response.IsTruncated !== true) return versions;
        if (
          response.NextKeyMarker === undefined ||
          response.NextVersionIdMarker === undefined
        )
          throw new Error("Truncated S3 version listing has no marker");
        return [
          ...versions,
          ...(await page({
            key: response.NextKeyMarker,
            version: response.NextVersionIdMarker,
          })),
        ];
      };
      return ResultAsync.fromPromise(
        page().then(
          (versions) =>
            versions.toSorted(
              (a, b) => b.modified.getTime() - a.modified.getTime(),
            )[0]?.id ?? null,
        ),
        failure,
      );
    },
    restoreIfAbsent(name, key, versionId) {
      // Read the version and write it back only if no current object exists:
      // the condition is atomic on the destination, and some S3 services
      // refuse to copy a version onto its own key.
      return ResultAsync.fromPromise(
        (async () => {
          const version = await buffer.send(
            new GetObjectCommand({
              Bucket: name,
              Key: key,
              VersionId: versionId,
            }),
          );
          if (version.Body === undefined)
            throw new Error("Missing S3 object body");
          const bytes = await version.Body.transformToByteArray();
          const restored = await unlessPresent(() =>
            buffer.send(
              new PutObjectCommand({
                Bucket: name,
                Key: key,
                Body: bytes,
                ...(version.ContentType === undefined
                  ? {}
                  : { ContentType: version.ContentType }),
                IfNoneMatch: "*",
              }),
            ),
          );
          return restored ? ("restored" as const) : ("present" as const);
        })(),
        failure,
      );
    },
  };
}
