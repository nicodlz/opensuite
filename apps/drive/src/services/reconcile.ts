import {
  DeleteObjectCommand,
  ListObjectsV2Command,
  ListMultipartUploadsCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import type { PrismaClient } from "../db/generated/index.js";

export type ReconciliationFinding =
  | { kind: "missing"; key: string; entryId: string }
  | {
      kind: "size_mismatch";
      key: string;
      entryId: string;
      expected: string;
      actual: number;
    }
  | { kind: "orphan"; key: string }
  | {
      kind: "multipart";
      key: string;
      uploadId: string;
      initiated: string | null;
    }
  | { kind: "deleted_staging"; key: string };

/** Lists metadata only. Final objects are never deleted by this operation. */
export async function reconcileObjects(
  db: PrismaClient,
  client: S3Client,
  options: {
    bucket: string;
    prefix: string;
    deleteStaging: boolean;
    now: Date;
  },
  report: (finding: ReconciliationFinding) => void,
) {
  const entries = await db.entry.findMany({
    where: { kind: "file", objectKey: { not: null } },
    select: { id: true, objectKey: true, size: true },
  });
  const byKey = new Map(
    entries.flatMap((entry) =>
      entry.objectKey === null ? [] : [[entry.objectKey, entry] as const],
    ),
  );
  const seen = new Set<string>();
  const stagingPrefix = `${options.prefix}pending/`;
  const safetyCutoff = options.now.getTime() - 7 * 24 * 60 * 60 * 1000;
  let cursor: string | undefined;
  // Pagination is sequential, and each deletion follows its own fresh check.
  /* oxlint-disable eslint/no-await-in-loop */
  do {
    const page = await client.send(
      new ListObjectsV2Command({
        Bucket: options.bucket,
        Prefix: options.prefix,
        ContinuationToken: cursor,
      }),
    );
    for (const object of page.Contents ?? []) {
      const key = object.Key;
      if (key === undefined || object.Size === undefined)
        throw new Error("incomplete object listing");
      const entry = byKey.get(key);
      if (entry !== undefined) {
        seen.add(key);
        if (entry.size !== BigInt(object.Size))
          report({
            kind: "size_mismatch",
            key,
            entryId: entry.id,
            expected: entry.size.toString(),
            actual: object.Size,
          });
        continue;
      }
      const stagingId = key.startsWith(stagingPrefix)
        ? key.slice(stagingPrefix.length)
        : "";
      // Only canonical upload IDs can identify an active reservation.
      const isStaging =
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          stagingId,
        );
      const reservation = isStaging
        ? await db.entry.findUnique({
            where: { id: stagingId },
            select: { state: true },
          })
        : null;
      if (reservation !== null && reservation.state !== "ready") continue;
      report({ kind: "orphan", key });
      if (
        options.deleteStaging &&
        isStaging &&
        object.LastModified !== undefined &&
        object.LastModified.getTime() < safetyCutoff &&
        object.ETag !== undefined
      ) {
        // Recheck immediately before a conditional delete. Never delete a final key.
        const current = await db.entry.findUnique({
          where: { id: stagingId },
          select: { state: true },
        });
        if (current !== null && current.state !== "ready") continue;
        await client.send(
          new DeleteObjectCommand({
            Bucket: options.bucket,
            Key: key,
            IfMatch: object.ETag,
          }),
        );
        report({ kind: "deleted_staging", key });
      }
    }
    if (page.IsTruncated && page.NextContinuationToken === undefined)
      throw new Error("incomplete object listing");
    cursor = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (cursor !== undefined);
  let keyMarker: string | undefined;
  let uploadIdMarker: string | undefined;
  do {
    const page = await client.send(
      new ListMultipartUploadsCommand({
        Bucket: options.bucket,
        Prefix: options.prefix,
        KeyMarker: keyMarker,
        UploadIdMarker: uploadIdMarker,
      }),
    );
    for (const upload of page.Uploads ?? []) {
      if (!upload.Key || !upload.UploadId)
        throw new Error("incomplete multipart listing");
      report({
        kind: "multipart",
        key: upload.Key,
        uploadId: upload.UploadId,
        initiated: upload.Initiated?.toISOString() ?? null,
      });
    }
    if (page.IsTruncated && !page.NextKeyMarker)
      throw new Error("incomplete multipart listing");
    keyMarker = page.IsTruncated ? page.NextKeyMarker : undefined;
    uploadIdMarker = page.IsTruncated ? page.NextUploadIdMarker : undefined;
  } while (keyMarker !== undefined);
  /* oxlint-enable eslint/no-await-in-loop */
  for (const [key, entry] of byKey)
    if (!seen.has(key)) report({ kind: "missing", key, entryId: entry.id });
}
