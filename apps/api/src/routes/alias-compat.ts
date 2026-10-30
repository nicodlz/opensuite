import { AliasWebsite } from "@opensuite/contracts";
import type { AliasService } from "@opensuite/core/services/aliases";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { createAliasLimiter } from "../auth/alias-limits.ts";

export function registerAliasCompat(
  app: FastifyInstance,
  options: {
    aliases: AliasService | undefined;
    limiter: ReturnType<typeof createAliasLimiter>;
  },
  ready: (error?: Error) => void,
) {
  configureAliasCompat(app);
  void app.post("/alias/random/new", async (request, reply) => {
    if (!options.limiter.ip(request.ip))
      return reply.code(429).send({ error: "Too many requests" });
    const secret = request.headers["authentication"];
    if (
      typeof secret !== "string" ||
      secret.length > 128 ||
      options.aliases === undefined
    )
      return reply.code(401).send({ error: "Invalid API key" });
    const actor = await options.aliases.authenticate(secret);
    if (actor.isErr())
      return reply.code(401).send({ error: "Invalid API key" });
    if (!options.limiter.key(actor.value.keyId))
      return reply.code(429).send({ error: "Too many requests" });
    const query = z
      .object({ hostname: z.unknown().optional() })
      .safeParse(request.query);
    const host = AliasWebsite.safeParse(
      query.success ? query.data.hostname : undefined,
    );
    const body = z
      .object({ note: z.string().max(500).optional() })
      .strict()
      .safeParse(request.body ?? {});
    if (!body.success)
      return reply.code(400).send({ error: "Invalid request" });
    if (!options.limiter.user(actor.value.userId))
      return reply.code(429).send({ error: "Too many requests" });
    const result = await options.aliases.create(actor.value.userId, {
      ...(host.success ? { website: host.data } : {}),
      ...(body.data.note === undefined ? {} : { note: body.data.note }),
    });
    if (result.isErr()) {
      const statuses = {
        invalid: 400,
        not_found: 404,
        conflict: 409,
        limit: 429,
        key_limit: 429,
        unavailable: 503,
        busy: 503,
      } satisfies Record<typeof result.error.kind, number>;
      return reply.code(statuses[result.error.kind]).send({
        error:
          result.error.kind === "limit"
            ? "Alias cap reached"
            : "Could not create alias",
      });
    }
    return reply.code(201).send({ alias: result.value.address });
  });
  ready();
}

function configureAliasCompat(app: FastifyInstance) {
  app.addHook("onRequest", (_request, reply, next) => {
    reply
      .header("Access-Control-Allow-Origin", "*")
      .header("Cache-Control", "no-store");
    next();
  });
  void app.options("/alias/random/new", (_request, reply) =>
    reply
      .header("Access-Control-Allow-Methods", "POST, OPTIONS")
      .header("Access-Control-Allow-Headers", "Authentication, Content-Type")
      .code(204)
      .send(),
  );
  app.removeContentTypeParser("application/json");
  const parseJson = app.getDefaultJsonParser("error", "error");
  app.addContentTypeParser(
    "application/json",
    { parseAs: "string" },
    (request, body, done) => {
      const text = body.toString();
      if (!text.trim()) done(null, {});
      else void parseJson(request, text, done);
    },
  );
  app.setErrorHandler((error, _request, reply) => {
    const parsed = z.object({ statusCode: z.number().int() }).safeParse(error);
    const status = parsed.success ? parsed.data.statusCode : 400;
    void reply.code(status >= 400 && status < 500 ? status : 503).send({
      error:
        status >= 400 && status < 500
          ? "Invalid request"
          : "Service unavailable",
    });
  });
}
