import type { FastifyInstance } from "fastify";
import type { ServerDependencies } from "./server-dependencies.ts";
import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { hasPendingFactor } from "../auth/limits.ts";
const tokenDigest = (value: string) =>
  createHash("sha256").update(value).digest();

const userIdParams = z.object({ userId: z.string().min(1).max(200) });

export function registerInternal(
  app: FastifyInstance,
  dependencies: ServerDependencies,
) {
  const internalAuthorized = (authorization: string | undefined) =>
    dependencies.internalToken !== undefined &&
    timingSafeEqual(
      tokenDigest(authorization ?? ""),
      tokenDigest(`Bearer ${dependencies.internalToken}`),
    );
  // Drive checks every request's session here rather than through
  // /auth/get-session: all its calls come from one container address, so the
  // per-network auth limits would be shared by every Drive user. The answer
  // is the same: no cache, and pending second factors, disabled accounts,
  // expired and revoked sessions all resolve to no user.
  app.get("/internal/session", async (request, reply) => {
    if (!internalAuthorized(request.headers.authorization))
      return reply.code(401).send({ code: "UNAUTHORIZED" });
    void reply.header("cache-control", "no-store");
    const actor = dependencies.identity?.actor;
    if (actor === undefined)
      return reply.code(503).send({ code: "SERVICE_UNAVAILABLE" });
    const cookie = request.headers.cookie;
    if (cookie === undefined || cookie === "" || hasPendingFactor(cookie))
      return { userId: null };
    try {
      return {
        userId: (await actor(new Headers({ cookie })))?.id ?? null,
      };
    } catch {
      return reply.code(503).send({ code: "SERVICE_UNAVAILABLE" });
    }
  });
  app.get("/internal/storage/:userId", async (request, reply) => {
    if (!internalAuthorized(request.headers.authorization))
      return reply.code(401).send({ code: "UNAUTHORIZED" });
    if (
      dependencies.entitlements === undefined ||
      dependencies.storageMeter === undefined
    )
      return reply.code(503).send({ code: "SERVICE_UNAVAILABLE" });
    const { userId } = userIdParams.parse(request.params);
    try {
      const entitlement = await dependencies.entitlements.get(userId);
      const mailBytes =
        entitlement.quotaBytes === null
          ? 0
          : await dependencies.storageMeter.mailBytes(userId);
      void reply.header("cache-control", "no-store");
      return {
        quotaBytes: entitlement.quotaBytes,
        uploadsAllowed: entitlement.uploadsAllowed,
        mailBytes,
      };
    } catch {
      return reply.code(503).send({ code: "SERVICE_UNAVAILABLE" });
    }
  });
  app.post("/internal/storage/:userId/refresh", async (request, reply) => {
    if (!internalAuthorized(request.headers.authorization))
      return reply.code(401).send({ code: "UNAUTHORIZED" });
    if (dependencies.storageMeter === undefined)
      return reply.code(503).send({ code: "SERVICE_UNAVAILABLE" });
    const { userId } = userIdParams.parse(request.params);
    try {
      await dependencies.storageMeter.refresh(userId);
      return { refreshed: true };
    } catch {
      return reply.code(503).send({ code: "SERVICE_UNAVAILABLE" });
    }
  });
}
