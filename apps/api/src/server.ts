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
