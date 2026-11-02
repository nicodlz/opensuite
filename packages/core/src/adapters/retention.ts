import {
  GetBucketLifecycleConfigurationCommand,
  GetBucketVersioningCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import { z } from "zod";

const retentionRules = z.object({
  Rules: z.array(
    z.object({
      Status: z.enum(["Enabled", "Disabled"]),
      Prefix: z.string().optional(),
      Filter: z
        .object({
          Prefix: z.string().optional(),
          And: z.object({ Prefix: z.string().optional() }).optional(),
        })
        .optional(),
      Expiration: z.unknown().optional(),
      NoncurrentVersionExpiration: z.unknown().optional(),
    }),
  ),
});

export const statusOf = (cause: unknown) => {
  const parsed = z
    .object({ $metadata: z.object({ httpStatusCode: z.number().optional() }) })
    .safeParse(cause);
  return parsed.success ? parsed.data.$metadata.httpStatusCode : undefined;
};

const unsafeRetention = () =>
  Object.assign(new Error("Inbound object retention is not protected"), {
    name: "UnsafeRetentionConfiguration",
  });

const lifecycleExpires = (response: unknown, key: string) =>
  retentionRules.parse(response).Rules.some((rule) => {
    const prefix =
      rule.Filter?.Prefix ?? rule.Filter?.And?.Prefix ?? rule.Prefix ?? "";
    return (
      rule.Status === "Enabled" &&
      key.startsWith(prefix) &&
      (rule.Expiration !== undefined ||
        rule.NoncurrentVersionExpiration !== undefined)
    );
  });

/** Refuse a delete marker if a stored original could expire before backup. */
export async function ensureRetained(
  client: S3Client,
  bucket: string,
  key: string,
): Promise<void> {
  const versioning = z
    .object({ Status: z.string().optional() })
    .parse(
      await client.send(new GetBucketVersioningCommand({ Bucket: bucket })),
    );
  if (versioning.Status !== "Enabled") throw unsafeRetention();
  let response;
  try {
    response = await client.send(
      new GetBucketLifecycleConfigurationCommand({ Bucket: bucket }),
    );
  } catch (cause) {
    if (
      cause instanceof Error &&
      cause.name === "NoSuchLifecycleConfiguration" &&
      statusOf(cause) === 404
    )
      return;
    throw cause;
  }
  if (lifecycleExpires(response, key)) throw unsafeRetention();
}
