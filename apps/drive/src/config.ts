import { err, ok } from "neverthrow";
import { z } from "zod";

const Env = z.object({
  DRIVE_HOST: z.string().default("0.0.0.0"),
  DRIVE_PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  DRIVE_DATABASE_URL: z
    .url()
    .refine((s) => ["postgres:", "postgresql:"].includes(new URL(s).protocol)),
  DRIVE_SESSION_API: z
    .url()
    .refine((s) => ["http:", "https:"].includes(new URL(s).protocol)),
  DRIVE_S3_ENDPOINT: z.url(),
  DRIVE_S3_PUBLIC_ENDPOINT: z.url(),
  DRIVE_S3_REGION: z.string().min(1),
  DRIVE_S3_BUCKET: z.string().min(3),
  DRIVE_S3_PREFIX: z.string().regex(/^(?:[a-zA-Z0-9_-]+\/)*$/),
  DRIVE_S3_ACCESS_KEY: z.string().min(1),
  DRIVE_S3_SECRET_KEY: z.string().min(1),
  DRIVE_S3_PATH_STYLE: z.enum(["true", "false"]).default("true"),
  // Exact origins whose pages may send state-changing requests.
  DRIVE_TRUSTED_ORIGINS: z
    .string()
    .transform((value) => value.split(/[\s,]+/).filter(Boolean))
    .pipe(
      z
        .array(
          z.url().refine((origin) => {
            const url = new URL(origin);
            return (
              ["http:", "https:"].includes(url.protocol) &&
              url.origin === origin &&
              !url.hostname.includes("*")
            );
          }),
        )
        .min(1),
    ),
  DRIVE_QUOTA_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .max(Number.MAX_SAFE_INTEGER)
    .default(10_000_000_000),
});
export const loadConfig = (environment: NodeJS.ProcessEnv) => {
  const parsed = Env.safeParse(environment);
  return parsed.success
    ? ok(parsed.data)
    : err({
        issues: parsed.error.issues.map((i) => ({
          path: i.path,
          message: i.message,
        })),
      });
};
