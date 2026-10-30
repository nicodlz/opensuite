import type { ReadinessService } from "@opensuite/core/services/readiness";
import { OpenAPIHandler } from "@orpc/openapi/fastify";
import { ORPCError } from "@orpc/server";
import Fastify, { LogController } from "fastify";
import { Readable } from "node:stream";
import { z } from "zod";
import type { Storage } from "./adapters/storage.ts";
import type { SessionVerifier } from "./domain/session.ts";
import type { DriveService } from "./services/drive.ts";
import { router, type Context } from "./routes/index.ts";

const Token = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const buildServer = (
  drive: DriveService,
  storage: Storage,
  sessions: SessionVerifier,
  readiness?: ReadinessService,
  trustedOrigins?: readonly string[],
) => {
  const app = Fastify({
    logger: true,
    logController: new LogController({ disableRequestLogging: true }),
  });
  app.addHook("onRequest", (request, reply, done) => {
    reply.header("x-request-id", request.id);
    done();
  });
  // Session cookies are SameSite=Lax, which does not separate sibling
  // subdomains. Refuse writes whose Origin is not an application origin.
  app.addHook("onRequest", async (request, reply) => {
    if (
      trustedOrigins !== undefined &&
      request.method !== "GET" &&
      request.method !== "HEAD" &&
      !trustedOrigins.includes(request.headers.origin ?? "")
    )
      return reply
        .code(403)
        .send({ code: "FORBIDDEN", message: "Invalid origin" });
    return undefined;
  });
  app.addHook("onResponse", (request, reply, done) => {
    request.log.info(
      {
        method: request.method,
        statusCode: reply.statusCode,
        durationMs: Math.round(reply.elapsedTime),
      },
      "request completed",
    );
    done();
  });
  const handler = new OpenAPIHandler<Context>(router);
  const identity = async (cookie: string | undefined) => {
    const result = await sessions.verify(cookie);
    if (result.isErr())
      throw new ORPCError("SERVICE_UNAVAILABLE", {
        message: "Session service unavailable",
      });
    if (result.value === null) throw new ORPCError("UNAUTHORIZED");
    return result.value;
  };
  app.get("/health", () => ({ status: "ok" }));
  app.get("/ready", async (_request, reply) => {
    if (readiness === undefined)
      return reply.code(503).send({ status: "not_ready" });
    const report = await readiness.check();
    return reply
      .code(report.readiness.status === "ready" ? 200 : 503)
      .send(report.readiness);
  });
  app.get("/v1/preview/:id", async (request, reply) => {
    const params = z
      .object({ id: z.string().min(1).max(200) })
      .parse(request.params);
    const entry = await drive.file(
      await identity(request.headers.cookie),
      params.id,
    );
    if (entry.objectKey === null || entry.contentType === null)
      throw new ORPCError("NOT_FOUND");
    if (
      !entry.contentType.startsWith("image/") &&
      entry.contentType !== "application/pdf"
    )
      return reply.code(415).send();
    const object = await storage.get(entry.objectKey);
    if (object.Body === undefined) throw new ORPCError("NOT_FOUND");
    return reply
      .headers({
        "content-type": entry.contentType,
        "content-disposition": "inline",
        "content-security-policy":
          "sandbox; default-src 'none'; style-src 'none'",
        "x-content-type-options": "nosniff",
        "cross-origin-resource-policy": "same-origin",
        "cache-control": "private, no-store",
      })
      .send(Readable.from(object.Body.transformToWebStream()));
  });
  app.get("/v1/public/:token", async (request, reply) => {
    const token = Token.parse(
      z.object({ token: z.string() }).parse(request.params).token,
    );
    const entry = await drive.publicFile(token);
    if (entry.objectKey === null) throw new ORPCError("NOT_FOUND");
    const object = await storage.get(entry.objectKey);
    if (object.Body === undefined) throw new ORPCError("NOT_FOUND");
    const filename = encodeURIComponent(entry.name).replace(
      /[!'()*]/g,
      (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
    );
    return reply
      .headers({
        "content-type": entry.contentType ?? "application/octet-stream",
        "content-disposition": `attachment; filename="download"; filename*=UTF-8''${filename}`,
        "content-security-policy": "sandbox; default-src 'none'",
        "x-content-type-options": "nosniff",
        "cache-control": "private, no-store",
        "referrer-policy": "no-referrer",
      })
      .send(Readable.from(object.Body.transformToWebStream()));
  });
  app.all("/*", async (request, reply) => {
    if (request.headers["sec-fetch-site"] === "cross-site")
      return reply.code(403).send({ code: "FORBIDDEN" });
    const userId = await identity(request.headers.cookie);
    const { matched } = await handler.handle(request, reply, {
      context: { userId, drive },
    });
    if (!matched) return reply.code(404).send({ code: "NOT_FOUND" });
    return reply;
  });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ORPCError)
      return reply
        .code(error.status)
        .send({ code: "DRIVE_ERROR", message: error.message });
    if (error instanceof z.ZodError)
      return reply.code(400).send({ code: "BAD_REQUEST" });
    const errorName = error instanceof Error ? error.name : "UnknownError";
    request.log.error({ errorName }, "Drive request failed");
    if (errorName === "NoSuchKey" || errorName === "NotFound")
      return reply.code(404).send({ code: "NOT_FOUND" });
    return reply.code(500).send({ code: "INTERNAL_SERVER_ERROR" });
  });
  return app;
};
