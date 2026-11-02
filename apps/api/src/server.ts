import { calendarImportLimits } from "@opensuite/contracts";
import {
  createCalendarImportStore,
  createSecretBox,
  type PrismaClient,
} from "@opensuite/db";
import { createCalendarImportService } from "@opensuite/core/services/migration-calendar";
import type { MailCredentialStore } from "@opensuite/core/services/jmap-access";
import * as calendarImportParser from "@opensuite/core/adapters/migration-calendar";
import { previews as calendarImportPreviews } from "@opensuite/core/adapters/migration-calendar-preview";
import Fastify, {
  LogController,
  type FastifyInstance,
  type FastifyRequest,
} from "fastify";
import type { Actor } from "@opensuite/core/services/accounts";
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

export function createCalendarImport(
  database: PrismaClient,
  config: { mailboxKey: string; stalwartOrigin: string },
  credentials: MailCredentialStore,
) {
  const box = createSecretBox(config.mailboxKey);
  if (box.isErr()) throw new Error("Invalid calendar import encryption key");
  return createCalendarImportService({
    store: credentials,
    origin: config.stalwartOrigin,
    imports: createCalendarImportStore(
      database,
      calendarImportLimits.jobs,
      box.value,
    ),
    parser: calendarImportParser,
    previews: calendarImportPreviews,
  });
}

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
