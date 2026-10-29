import type { ReadinessService } from "@opensuite/core/services/readiness";
import { OpenAPIGenerator } from "@orpc/openapi";
import { OpenAPIHandler } from "@orpc/openapi/fastify";
import { ORPCError, onError } from "@orpc/server";
import { ZodToJsonSchemaConverter } from "@orpc/zod/zod4";
import Fastify, { type FastifyInstance } from "fastify";
import type { ApiConfig } from "./config.ts";
import { router, type ApiContext } from "./routes/index.ts";

export interface ServerDependencies {
  readonly config: Pick<ApiConfig, "logLevel">;
  readonly readiness: ReadinessService;
  readonly monotonicMs: () => number;
}

export const buildServer = async (
  dependencies: ServerDependencies,
): Promise<FastifyInstance> => {
  const app = Fastify({
    logger: { level: dependencies.config.logLevel },
  });
  const startedAt = dependencies.monotonicMs();

  const handler = new OpenAPIHandler<ApiContext>(router, {
    interceptors: [
      onError((error, { context }) => {
        // Declared and client errors (validation, NOT_READY) are expected outcomes.
        if (
          error instanceof ORPCError &&
          (error.defined || error.status < 500)
        ) {
          return;
        }
        context.log.error({ err: error }, "procedure failed");
      }),
    ],
  });

  const openapi = await new OpenAPIGenerator({
    schemaConverters: [new ZodToJsonSchemaConverter()],
  }).generate(router, {
    info: { title: "OpenSuite API", version: "0.0.0" },
  });

  app.get("/openapi.json", () => openapi);

  app.all("/*", async (request, reply) => {
    const { matched } = await handler.handle(request, reply, {
      context: {
        log: request.log,
        readiness: dependencies.readiness,
        uptimeSeconds: () =>
          Math.floor((dependencies.monotonicMs() - startedAt) / 1000),
      },
    });
    if (!matched) {
      return reply
        .code(404)
        .send({ code: "NOT_FOUND", message: "No such route" });
    }
    return reply;
  });

  return app;
};
