import { requestHeaders } from "./request-headers.ts";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { ServerDependencies } from "../routes/server-dependencies.ts";
import type { Actor } from "@opensuite/core/services/accounts";
import {
  hasDuplicateAuthCookie,
  hasPendingFactor,
  hasTrustDevice,
} from "./limits.ts";
function checkAuthPathAndCookies(
  request: FastifyRequest,
  reply: FastifyReply,
  dependencies: ServerDependencies,
) {
  const identity = dependencies.identity;
  const rawPath = request.url.split("?")[0] ?? "";
  if (
    identity !== undefined &&
    (rawPath.startsWith("/auth/") || rawPath.startsWith("/api/auth/"))
  ) {
    const normalized = new URL(request.url, identity.publicOrigin).pathname;
    if (
      rawPath !== normalized ||
      rawPath.includes("%") ||
      rawPath.includes("//") ||
      rawPath.split("/").some((segment) => segment === "." || segment === "..")
    ) {
      return reply.code(400).send({
        code: "BAD_REQUEST",
        message: "Invalid authentication path",
      });
    }
  }
  if (identity !== undefined && hasDuplicateAuthCookie(request.headers.cookie))
    return reply.code(400).send({
      code: "BAD_REQUEST",
      message: "Duplicate authentication cookie",
    });
  if (identity !== undefined && hasTrustDevice(request.headers.cookie))
    return reply
      .header(
        "set-cookie",
        "__Host-opensuite.trust_device=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Lax",
      )
      .code(400)
      .send({
        code: "BAD_REQUEST",
        message: "Trusted devices are not supported",
      });
  return undefined;
}
function checkRequestOrigin(
  request: FastifyRequest,
  reply: FastifyReply,
  dependencies: ServerDependencies,
) {
  const identity = dependencies.identity;
  const rawPath = request.url.split("?")[0] ?? "";
  if (rawPath === "/alias/random/new") return undefined;
  const pendingFactor = hasPendingFactor(request.headers.cookie);
  if (
    identity !== undefined &&
    pendingFactor &&
    rawPath !== "/internal/session" &&
    !rawPath.startsWith("/auth/") &&
    !rawPath.startsWith("/api/auth/")
  )
    return reply.code(401).send({
      code: "UNAUTHORIZED",
      message: "Complete two-factor authentication",
    });
  return checkMutationOrigin(request, reply, dependencies, rawPath);
}
function checkMutationOrigin(
  request: FastifyRequest,
  reply: FastifyReply,
  dependencies: ServerDependencies,
  rawPath: string,
) {
  const identity = dependencies.identity;
  if (
    identity !== undefined &&
    request.method !== "GET" &&
    request.method !== "HEAD" &&
    !(
      request.method === "POST" &&
      rawPath === "/billing/webhook" &&
      dependencies.webhook !== undefined
    ) &&
    !(
      request.method === "POST" &&
      /^\/internal\/storage\/[^/]+\/refresh$/.test(rawPath)
    ) &&
    !(identity.trustedOrigins ?? [identity.publicOrigin]).includes(
      request.headers.origin ?? "",
    )
  ) {
    return reply
      .code(403)
      .send({ code: "FORBIDDEN", message: "Invalid origin" });
  }
  return undefined;
}
async function checkUpload(
  request: FastifyRequest,
  reply: FastifyReply,
  dependencies: ServerDependencies,
  actors: WeakMap<FastifyRequest, Actor | null>,
) {
  const identity = dependencies.identity;
  const rawPath = request.url.split("?")[0] ?? "";
  if (rawPath === "/alias/random/new") return undefined;
  if (request.method === "POST" && rawPath === "/mail/attachments/upload") {
    const headers = requestHeaders(request);
    const actor = (await identity?.actor?.(headers)) ?? null;
    if (actor === null)
      return reply
        .code(401)
        .send({ code: "UNAUTHORIZED", message: "Unauthorized" });
    actors.set(request, actor);
  }
  return undefined;
}
export function registerRequestHooks(
  app: FastifyInstance,
  dependencies: ServerDependencies,
  actors: WeakMap<FastifyRequest, Actor | null>,
) {
  app.addHook("onRequest", (request, reply, done) => {
    void reply.header("x-request-id", request.id);
    done();
  });
  app.addHook("onResponse", (request, reply, done) => {
    const { method } = request;
    const { statusCode } = reply;
    request.log.info(
      { method, statusCode, durationMs: Math.round(reply.elapsedTime) },
      "request completed",
    );
    done();
  });
  app.addHook("onRequest", async (request, reply) => {
    const invalidAuth = checkAuthPathAndCookies(request, reply, dependencies);
    if (invalidAuth !== undefined) return invalidAuth;
    const invalidOrigin = checkRequestOrigin(request, reply, dependencies);
    if (invalidOrigin !== undefined) return invalidOrigin;
    return checkUpload(request, reply, dependencies, actors);
  });
}
