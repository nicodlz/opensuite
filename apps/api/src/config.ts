import { err, ok, type Result } from "neverthrow";
import { readFile } from "node:fs/promises";
import { z } from "zod";

const EnvSchema = z.object({
  API_HOST: z.string().min(1).default("127.0.0.1"),
  API_PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
  STALWART_READY_URL: z.url().default("http://stalwart:8080/healthz/ready"),
  READINESS_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(50)
    .max(30_000)
    .default(2000),
});

export interface ApiConfig {
  readonly stalwartReadyUrl: string;
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
    stalwartReadyUrl: parsed.data.STALWART_READY_URL,
    host: parsed.data.API_HOST,
    port: parsed.data.API_PORT,
    logLevel: parsed.data.LOG_LEVEL,
    readinessTimeoutMs: parsed.data.READINESS_TIMEOUT_MS,
  });
};

const DatabaseEnvironment = z.object({
  DATABASE_URL: z.url().optional(),
  POSTGRES_HOST: z.string().min(1).optional(),
  POSTGRES_DB: z.string().min(1).optional(),
  APP_DATABASE_PASSWORD_FILE: z.string().min(1).optional(),
});

/** Resolve secrets without returning file contents or driver errors to logs. */
export const loadApplicationDatabaseUrl = async (
  env: Readonly<Record<string, string | undefined>>,
): Promise<Result<string, ConfigError>> => {
  const parsed = DatabaseEnvironment.safeParse(env);
  if (!parsed.success)
    return err({
      kind: "invalid_environment",
      issues: ["invalid database configuration"],
    });
  if (parsed.data.DATABASE_URL !== undefined)
    return ok(parsed.data.DATABASE_URL);
  const {
    POSTGRES_HOST: host,
    POSTGRES_DB: database,
    APP_DATABASE_PASSWORD_FILE: file,
  } = parsed.data;
  if (host === undefined || database === undefined || file === undefined)
    return err({
      kind: "invalid_environment",
      issues: ["database connection is not configured"],
    });
  try {
    const password = (await readFile(file, "utf8")).trim();
    if (password.length < 32)
      return err({
        kind: "invalid_environment",
        issues: ["invalid database secret"],
      });
    const url = new URL("postgresql://localhost:5432/");
    url.hostname = host;
    url.username = "opensuite_app";
    url.password = password;
    url.pathname = `/${encodeURIComponent(database)}`;
    return ok(url.toString());
  } catch {
    return err({
      kind: "invalid_environment",
      issues: ["database secret unavailable"],
    });
  }
};
