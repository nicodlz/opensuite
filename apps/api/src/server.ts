import { createDirectMigrationService } from "@opensuite/core/services/migration-direct";
import type { MailCredentialStore } from "@opensuite/core/services/jmap-access";
import {
  createDirectConnector,
  directDestinationPolicy,
  revokeGoogleToken,
  directMigrationTools,
} from "@opensuite/core/adapters/migration-direct";
import type { PrismaClient } from "@opensuite/db";
import Fastify, {
  LogController,
  type FastifyInstance,
  type FastifyRequest,
} from "fastify";
import type { Actor } from "@opensuite/core/services/accounts";
import { z } from "zod";
import { createMailImport } from "./push-runtime.ts";
import { createAliasLimiter } from "./auth/alias-limits.ts";
import { registerRequestHooks } from "./auth/request-hooks.ts";
import { registerAuthRoutes } from "./auth/auth-routes.ts";
import { registerAliasCompat } from "./routes/alias-compat.ts";
import { registerDownloads } from "./routes/downloads.ts";
import { registerOpenApi } from "./routes/openapi.ts";
import { registerBillingWebhook } from "./routes/billing-webhook.ts";
import { registerInternal } from "./routes/internal.ts";
import { registerVault } from "./routes/vault-route.ts";
import { registerDispatch } from "./routes/dispatch.ts";
import type { ServerDependencies } from "./routes/server-dependencies.ts";
export type { ServerDependencies } from "./routes/server-dependencies.ts";

export const buildServer = async (
  dependencies: ServerDependencies,
): Promise<FastifyInstance> => {
  const app = Fastify({
    bodyLimit: 1_000_000,
    logger: {
      level: dependencies.config.logLevel,
      redact: [
        "req.headers.authentication",
        "req.headers.authorization",
        "req.headers.cookie",
        "request.headers.authentication",
        "request.headers.authorization",
        "request.headers.cookie",
      ],
    },
    logController: new LogController({ disableRequestLogging: true }),
    trustProxy: dependencies.config.trustProxy ?? false,
  });
  const startedAt = dependencies.monotonicMs();
  const aliasLimits = createAliasLimiter();
  const addressLimits = createAliasLimiter();
  const actors = new WeakMap<FastifyRequest, Actor | null>();
  registerRequestHooks(app, dependencies, actors);
  const downloads = registerDownloads(app, dependencies);
  const handler = await registerOpenApi(app);
  await registerBillingWebhook(app, dependencies);
  registerInternal(app, dependencies);
  await app.register(registerAliasCompat, {
    aliases: dependencies.aliases,
    limiter: aliasLimits,
  });
  registerVault(app, dependencies);
  registerAuthRoutes(app, dependencies);
  registerDispatch(
    app,
    dependencies,
    actors,
    downloads,
    handler,
    startedAt,
    aliasLimits,
    addressLimits,
  );
  return app;
};

export function configureDirectImport(
  db: PrismaClient,
  config: { mailboxKey: string; stalwartOrigin: string },
  store: MailCredentialStore,
  env: Readonly<Record<string, string | undefined>>,
) {
  const settings = z
    .object({
      MAIL_MIGRATION_IMAP_ALLOW: z.string().optional(),
      MAIL_MIGRATION_GOOGLE_OAUTH: z.enum(["true", "false"]).default("false"),
    })
    .parse(env);
  return createDirectMigrationService({
    db,
    key: config.mailboxKey,
    store,
    origin: config.stalwartOrigin,
    tools: directMigrationTools,
    connectSource: createDirectConnector(
      directDestinationPolicy(settings.MAIL_MIGRATION_IMAP_ALLOW),
    ),
    oauthEnabled: settings.MAIL_MIGRATION_GOOGLE_OAUTH === "true",
    revokeOAuth: revokeGoogleToken,
  });
}
export function configureMailImports(
  db: PrismaClient,
  config: { mailboxKey: string; stalwartOrigin: string },
  mailboxes: Parameters<typeof createMailImport>[2],
) {
  const migrationMail = createMailImport(db, config, mailboxes);
  const store = {
    getForOwner: async (userId: string, accountId: string) =>
      mailboxes.getForOwner(userId, accountId),
  };
  const migrationDirect = configureDirectImport(db, config, store, process.env);
  return { migrationMail, migrationDirect };
}
export function registerShutdown(app: FastifyInstance) {
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      app.log.info({ signal }, "shutting down");
      void app.close();
    });
  }
}
