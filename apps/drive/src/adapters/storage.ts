import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CopyObjectCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { createHash } from "node:crypto";
import { verifiedType } from "../domain/content.ts";

export class UploadMismatchError extends Error {}

export interface StorageConfig {
  endpoint: string;
  publicEndpoint: string;
  region: string;
  bucket: string;
  prefix: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
}
export const createStorage = (config: StorageConfig) => {
  const common = {
    region: config.region,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
    forcePathStyle: config.forcePathStyle,
  };
  const client = new S3Client({ ...common, endpoint: config.endpoint });
  const publicClient = new S3Client({
    ...common,
    endpoint: config.publicEndpoint,
  });
  const Bucket = config.bucket;
  const key = (id: string, stage: boolean) =>
    `${config.prefix}${stage ? "pending" : "objects"}/${id}`;
  return {
    key,
    async initiate(
      id: string,
      contentType: string,
      multipart: boolean,
      size: number,
    ) {
      const Key = key(id, true);
      if (multipart) {
        const result = await client.send(
          new CreateMultipartUploadCommand({
            Bucket,
            Key,
            ContentType: contentType,
          }),
        );
        if (result.UploadId === undefined)
          throw new Error("storage did not return upload id");
        return { uploadId: result.UploadId, url: null };
      }
      const url = await getSignedUrl(
        publicClient,
        new PutObjectCommand({
          Bucket,
          Key,
          ContentType: contentType,
          ContentLength: size,
        }),
        {
          expiresIn: 300,
          signableHeaders: new Set(["content-type", "content-length"]),
        },
      );
      return { uploadId: null, url };
    },
    async part(
      id: string,
      uploadId: string,
      partNumber: number,
      size: number,
      expiresIn: number,
    ) {
      return getSignedUrl(
        publicClient,
        new UploadPartCommand({
          Bucket,
          Key: key(id, true),
          UploadId: uploadId,
          PartNumber: partNumber,
          ContentLength: size,
        }),
        { expiresIn, signableHeaders: new Set(["content-length"]) },
      );
    },
    async complete(
      id: string,
      uploadId: string,
      parts: { partNumber: number; etag: string }[],
    ) {
      await client.send(
        new CompleteMultipartUploadCommand({
          Bucket,
          Key: key(id, true),
          UploadId: uploadId,
          MultipartUpload: {
            Parts: parts.map((part) => ({
              PartNumber: part.partNumber,
              ETag: part.etag,
            })),
          },
        }),
      );
    },
    async verifyAndCopy(
      id: string,
      size: number,
      checksum: string,
      contentType: string,
    ) {
      const Key = key(id, true);
      const head = await client.send(new HeadObjectCommand({ Bucket, Key }));
      if (
        head.ContentLength !== size ||
        head.ContentType !== contentType ||
        head.ETag === undefined
      )
        throw new UploadMismatchError("upload metadata mismatch");
      const object = await client.send(
        new GetObjectCommand({ Bucket, Key, IfMatch: head.ETag }),
      );
      if (object.Body === undefined) throw new Error("missing object body");
      const hash = createHash("sha256");
      let length = 0;
      let first = Buffer.alloc(0);
      for await (const chunk of object.Body.transformToWebStream()) {
        const bytes = Buffer.from(chunk);
        length += bytes.length;
        if (length > size)
          throw new UploadMismatchError("upload size mismatch");
        hash.update(bytes);
        if (first.length < 16)
          first = Buffer.concat([first, bytes.subarray(0, 16 - first.length)]);
      }
      if (length !== size || hash.digest("hex") !== checksum)
        throw new UploadMismatchError("upload checksum mismatch");
      const safeType = verifiedType(contentType, first);
      await client.send(
        new CopyObjectCommand({
          Bucket,
          Key: key(id, false),
          CopySource: `${encodeURIComponent(Bucket)}/${Key.split("/").map(encodeURIComponent).join("/")}`,
          CopySourceIfMatch: head.ETag,
          MetadataDirective: "REPLACE",
          ContentType: safeType,
          ContentDisposition: "attachment",
        }),
      );
      return safeType;
    },
    async removeStaging(id: string) {
      await client.send(
        new DeleteObjectCommand({ Bucket, Key: key(id, true) }),
      );
    },
    async download(objectKey: string, name: string, contentType: string) {
      // ASCII fallback plus RFC 5987 filename prevents header injection.
      const disposition = `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(name).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`;
      return getSignedUrl(
        publicClient,
        new GetObjectCommand({
          Bucket,
          Key: objectKey,
          ResponseContentDisposition: disposition,
          ResponseContentType: contentType,
        }),
        { expiresIn: 300 },
      );
    },
    async get(objectKey: string) {
      return client.send(new GetObjectCommand({ Bucket, Key: objectKey }));
    },
    async remove(
      id: string,
      objectKey: string | null,
      uploadId: string | null,
    ) {
      if (uploadId !== null) {
        try {
          await client.send(
            new AbortMultipartUploadCommand({
              Bucket,
              Key: key(id, true),
              UploadId: uploadId,
            }),
          );
        } catch (error) {
          // A previous completion or cleanup may already have consumed the upload.
          if (!(error instanceof Error) || error.name !== "NoSuchUpload")
            throw error;
        }
      }
      await client.send(
        new DeleteObjectCommand({ Bucket, Key: key(id, true) }),
      );
      await client.send(
        new DeleteObjectCommand({ Bucket, Key: key(id, false) }),
      );
      if (objectKey !== null && objectKey !== key(id, false))
        await client.send(new DeleteObjectCommand({ Bucket, Key: objectKey }));
    },
    close() {
      client.destroy();
      publicClient.destroy();
    },
  };
};
export type Storage = ReturnType<typeof createStorage>;
