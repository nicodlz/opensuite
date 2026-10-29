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
  readonly identity?: {
    readonly handler: (request: Request) => Promise<Response>;
    readonly publicOrigin: string;
  };
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

  if (dependencies.identity !== undefined) {
    const identity = dependencies.identity;
    app.all("/auth/*", async (request, reply) => {
      if (
        request.method !== "GET" &&
        request.method !== "HEAD" &&
        request.headers.origin !== identity.publicOrigin
      ) {
        return reply
          .code(403)
          .send({ code: "FORBIDDEN", message: "Invalid origin" });
      }
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) {
        if (name === "host" || name === "content-length" || value === undefined)
          continue;
        if (Array.isArray(value)) {
          for (const part of value) headers.append(name, part);
        } else headers.set(name, value);
      }
      const url = new URL(`/api${request.url}`, identity.publicOrigin);
      const body =
        request.method === "GET" || request.method === "HEAD"
          ? undefined
          : JSON.stringify(request.body);
      const response = await identity.handler(
        new Request(url, {
          method: request.method,
          headers,
          ...(body === undefined ? {} : { body }),
        }),
      );
      reply.code(response.status);
      for (const [name, value] of response.headers) {
        if (name !== "set-cookie" && name !== "content-length")
          reply.header(name, value);
      }
      const cookies = response.headers.getSetCookie();
      if (cookies.length > 0) reply.header("set-cookie", cookies);
      return reply.send(await response.text());
    });
  }

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
