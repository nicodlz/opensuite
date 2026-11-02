import { OpenAPIGenerator } from "@orpc/openapi";
import { OpenAPIHandler } from "@orpc/openapi/fastify";
import { ORPCError, onError } from "@orpc/server";
import { ZodToJsonSchemaConverter } from "@orpc/zod/zod4";
import type { FastifyInstance } from "fastify";
import { router, type ApiContext } from "./index.ts";
export async function registerOpenApi(app: FastifyInstance) {
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
        const knownMessages = new Set([
          "account lookup failed",
          "audit unavailable",
          "mailbox provisioning failed",
        ]);
        const name =
          error instanceof Error &&
          /^(?:Error|TypeError|RangeError|ReferenceError|SyntaxError)$/.test(
            error.name,
          )
            ? error.name
            : "Error";
        const message =
          error instanceof Error && knownMessages.has(error.message)
            ? error.message
            : "[redacted]";
        const stack =
          error instanceof Error
            ? (error.stack ?? "")
                .split("\n")
                .slice(1)
                .flatMap((line) => {
                  const frame =
                    /\bat ([\w.$<>]+) \((?:.*\/)?([\w.-]+\.[cm]?[jt]s):(\d+):(\d+)\)$/.exec(
                      line,
                    );
                  return frame === null
                    ? []
                    : [
                        `at ${String(frame[1])} (${String(frame[2])}:${String(frame[3])}:${String(frame[4])})`,
                      ];
                })
                .join("\n")
            : "";
        context.log.error(
          { error: { name, message, stack } },
          "procedure failed",
        );
      }),
    ],
  });

  const openapi = await new OpenAPIGenerator({
    schemaConverters: [new ZodToJsonSchemaConverter()],
  }).generate(router, {
    info: { title: "Esuno API", version: "0.0.0" },
  });

  app.get("/openapi.json", () => openapi);
  return handler;
}
