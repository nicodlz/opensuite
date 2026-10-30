import { err, ok, type Result } from "neverthrow";
import { readFile } from "node:fs/promises";
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
  ALIAS_PER_USER_CAP: z.coerce.number().int().min(1).max(100000).default(1000),
});

export interface ApiConfig {
  readonly host: string;
  readonly port: number;
  readonly logLevel: z.infer<typeof EnvSchema>["LOG_LEVEL"];
  readonly readinessTimeoutMs: number;
  readonly aliasPerUserCap: number;
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
    aliasPerUserCap: parsed.data.ALIAS_PER_USER_CAP,
  });
};

const DatabaseEnvironment = z.object({
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

const AuthEnvironment = z.object({
  TRUSTED_PROXY_IP: z.ipv4(),
  AUTH_PUBLIC_ORIGIN: z.url().refine((value) => {
    const url = new URL(value);
    return url.protocol === "https:" && url.origin === value;
  }),
  MAIL_DOMAIN: z
    .string()
    .min(1)
    .regex(
      /^(?=.{1,253}$)[a-z0-9]+(?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9]+(?:[a-z0-9-]*[a-z0-9])?)+$/,
    ),
  STALWART_INTERNAL_ORIGIN: z.url().refine((value) => {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && url.origin === value;
  }),
  STALWART_MANAGEMENT_CLIENT_IP: z.ipv4().optional(),
  AUTH_PRODUCT_ORIGINS: z.string().optional(),
  PASS_PUBLIC_HOST: z.string().default("pass.localhost"),
  AUTH_SECRET_FILE: z.string().min(1),
  MAILBOX_KEY_FILE: z.string().min(1),
  STALWART_MANAGEMENT_PASSWORD_FILE: z.string().min(1),
});

const productNames = ["mail", "drive", "calendar", "pass"] as const;
export type ProductName = (typeof productNames)[number];
/**
 * Parses application origins and the optional `pass=https://pass.example` vault.
 * Pass is separated before configuring authentication and handoffs.
 * Mail is always served by the public authentication origin. Every origin
 * must be an exact HTTPS origin; wildcards and parent domains are refused.
 */
export const parseProductOrigins = (
  publicOrigin: string,
  value: string | undefined,
): Partial<Record<ProductName, string>> | null => {
  const origins: Partial<Record<ProductName, string>> = { mail: publicOrigin };
  for (const entry of (value ?? "").split(",")) {
    const item = entry.trim();
    if (item === "") continue;
    const separator = item.indexOf("=");
    const name = item.slice(0, separator);
    const origin = item.slice(separator + 1);
    const product = productNames.find((candidate) => candidate === name);
    if (separator < 1 || product === undefined || product === "mail")
      return null;
    if (origins[product] !== undefined) return null;
    try {
      const url = new URL(origin);
      if (
        url.protocol !== "https:" ||
        url.origin !== origin ||
        !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(
          url.hostname,
        )
      )
        return null;
    } catch {
      return null;
    }
    if (Object.values(origins).includes(origin)) return null;
    origins[product] = origin;
  }
  return origins;
};

export const loadAuthConfig = async (
  env: Readonly<Record<string, string | undefined>>,
) => {
  const parsed = AuthEnvironment.safeParse(env);
  if (!parsed.success)
    return err<never, ConfigError>({
      kind: "invalid_environment",
      issues: ["invalid authentication configuration"],
    });
  try {
    const [secret, mailboxKey, adminPassword] = await Promise.all([
      readFile(parsed.data.AUTH_SECRET_FILE, "utf8"),
      readFile(parsed.data.MAILBOX_KEY_FILE, "utf8"),
      readFile(parsed.data.STALWART_MANAGEMENT_PASSWORD_FILE, "utf8"),
    ]);
    const values = z
      .object({
        secret: z.string().min(32),
        mailboxKey: z.string().regex(/^[a-f0-9]{64}$/),
        adminPassword: z.string().min(32),
      })
      .safeParse({
        secret: secret.trim(),
        mailboxKey: mailboxKey.trim(),
        adminPassword: adminPassword.trim(),
      });
    if (!values.success)
      return err<never, ConfigError>({
        kind: "invalid_environment",
        issues: ["invalid authentication secrets"],
      });
    const productOrigins = parseProductOrigins(
      parsed.data.AUTH_PUBLIC_ORIGIN,
      parsed.data.AUTH_PRODUCT_ORIGINS,
    );
    if (productOrigins === null)
      return err<never, ConfigError>({
        kind: "invalid_environment",
        issues: ["invalid product origins"],
      });
    const { pass: passOrigin, ...appOrigins } = productOrigins;
    if (
      passOrigin !== undefined &&
      passOrigin !== `https://${parsed.data.PASS_PUBLIC_HOST.toLowerCase()}`
    )
      return err<never, ConfigError>({
        kind: "invalid_environment",
        issues: ["Pass origin must match PASS_PUBLIC_HOST"],
      });
    return ok({
      publicOrigin: parsed.data.AUTH_PUBLIC_ORIGIN,
      productOrigins: appOrigins,
      ...(passOrigin === undefined ? {} : { passOrigin }),
      mailDomain: parsed.data.MAIL_DOMAIN,
      trustedProxyIp: parsed.data.TRUSTED_PROXY_IP,
      stalwartOrigin: parsed.data.STALWART_INTERNAL_ORIGIN,
      mailReadyUrl: new URL(
        "/healthz/ready",
        parsed.data.STALWART_INTERNAL_ORIGIN,
      ).toString(),
      ...(parsed.data.STALWART_MANAGEMENT_CLIENT_IP === undefined
        ? {}
        : { managementClientIp: parsed.data.STALWART_MANAGEMENT_CLIENT_IP }),
      ...values.data,
    });
  } catch {
    return err<never, ConfigError>({
      kind: "invalid_environment",
      issues: ["authentication secrets unavailable"],
    });
  }
};
