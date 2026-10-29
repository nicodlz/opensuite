import { err, ok, type Result } from "neverthrow";
import { z } from "zod";

const EnvSchema = z.object({
  API_HOST: z.string().min(1).default("127.0.0.1"),
  API_PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
  READINESS_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(50)
    .max(30_000)
    .default(2000),
});

export interface ApiConfig {
  readonly host: string;
  readonly port: number;
  readonly logLevel: z.infer<typeof EnvSchema>["LOG_LEVEL"];
  readonly readinessTimeoutMs: number;
}

export interface ConfigError {
  readonly kind: "invalid_environment";
  /** Variable names and reasons only; values are never echoed. */
  readonly issues: readonly string[];
}

export const loadConfig = (
  env: Readonly<Record<string, string | undefined>>,
): Result<ApiConfig, ConfigError> => {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    return err({
      kind: "invalid_environment",
      issues: parsed.error.issues.map(
        (issue) => `${issue.path.join(".")}: ${issue.message}`,
      ),
    });
  }
  return ok({
    host: parsed.data.API_HOST,
    port: parsed.data.API_PORT,
    logLevel: parsed.data.LOG_LEVEL,
    readinessTimeoutMs: parsed.data.READINESS_TIMEOUT_MS,
  });
};
