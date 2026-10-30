import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CopyObjectCommand,
  CreateMultipartUploadCommand,
  UploadPartCopyCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import { DRIVE_MAX_PARTS } from "@opensuite/contracts";

// CopyObject cannot copy objects larger than 5 GB. Pin every copy to the
// verified source ETag, including each part of a multipart copy.
export async function copyVerifiedObject(
  client: S3Client,
  bucket: string,
  sourceKey: string,
  targetKey: string,
  size: number,
  etag: string,
  contentType: string,
) {
  const copySource = `${encodeURIComponent(bucket)}/${sourceKey.split("/").map(encodeURIComponent).join("/")}`;
  if (size <= 5_000_000_000) {
    await client.send(
      new CopyObjectCommand({
        Bucket: bucket,
        Key: targetKey,
        CopySource: copySource,
        CopySourceIfMatch: etag,
        MetadataDirective: "REPLACE",
        ContentType: contentType,
        ContentDisposition: "attachment",
      }),
    );
    return;
  }
  const started = await client.send(
    new CreateMultipartUploadCommand({
      Bucket: bucket,
      Key: targetKey,
      ContentType: contentType,
      ContentDisposition: "attachment",
    }),
  );
  if (!started.UploadId)
    throw new Error("storage did not return copy upload id");
  const uploadId = started.UploadId;
  try {
    const partSize = Math.max(
      512 * 1024 * 1024,
      Math.ceil(size / DRIVE_MAX_PARTS),
    );
    const parts: { PartNumber: number; ETag: string }[] = [];
    await Array.from(
      { length: Math.ceil(size / partSize) },
      (_, index) => index,
    ).reduce<Promise<void>>(async (previous, index) => {
      await previous;
      const offset = index * partSize;
      const number = index + 1;
      const result = await client.send(
        new UploadPartCopyCommand({
          Bucket: bucket,
          Key: targetKey,
          UploadId: uploadId,
          PartNumber: number,
          CopySource: copySource,
          CopySourceIfMatch: etag,
          CopySourceRange: `bytes=${offset}-${Math.min(offset + partSize, size) - 1}`,
        }),
      );
      if (!result.CopyPartResult?.ETag)
        throw new Error("storage did not return copy part ETag");
      parts.push({ PartNumber: number, ETag: result.CopyPartResult.ETag });
    }, Promise.resolve());
    await client.send(
      new CompleteMultipartUploadCommand({
        Bucket: bucket,
        Key: targetKey,
        UploadId: uploadId,
        MultipartUpload: { Parts: parts },
      }),
    );
  } catch (error) {
    try {
      await client.send(
        new AbortMultipartUploadCommand({
          Bucket: bucket,
          Key: targetKey,
          UploadId: uploadId,
        }),
      );
    } catch (cleanupError) {
      throw new Error("Multipart copy and cleanup failed", {
        cause: cleanupError,
      });
    }
    throw error;
  }
}
