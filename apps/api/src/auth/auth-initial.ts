import { z } from "zod";
import type { AuthRequestContext } from "./auth-context.ts";
import { networkBucket } from "./alias-limits.ts";

export async function validateAuthRequest(context: AuthRequestContext) {
  const {
    request,
    reply,
    identity,
    limiter,
    signInLookupLimit,
    path,
    pendingFactor,
  } = context;
  if (
    pendingFactor &&
    path !== "/auth/get-session" &&
    path !== "/auth/sign-out" &&
    !path.startsWith("/auth/two-factor/")
  )
    return reply.code(401).send({
      code: "UNAUTHORIZED",
      message: "Complete two-factor authentication",
    });
  if (
    path.startsWith("/auth/two-factor/verify-") &&
    z.object({ trustDevice: z.literal(true) }).safeParse(request.body).success
  )
    return reply.code(400).send({
      code: "BAD_REQUEST",
      message: "Trusted devices are not supported",
    });
  // Tokens are only issued through /session/handoff.
  if (path === "/auth/one-time-token/generate")
    return reply
      .code(404)
      .send({ code: "NOT_FOUND", message: "No such route" });
  if (limiter.hasDuplicateChallenge(request.headers.cookie)) {
    return reply.code(400).send({
      code: "BAD_REQUEST",
      message: "Duplicate authentication cookie",
    });
  }
  if (path === "/auth/sign-in/email" && request.method === "POST") {
    const lookupLimit = signInLookupLimit.consume(
      networkBucket(request.ip),
      50,
      60_000,
    );
    if (lookupLimit) {
      if (lookupLimit.first)
        await identity.audit?.({
          userId: null,
          action: "authentication.rate_limited",
        });
      return reply
        .header("retry-after", String(lookupLimit.retryAfter))
        .code(429)
        .send({ code: "TOO_MANY_REQUESTS", message: "Try again later" });
    }
  }
  return undefined;
}

export async function resolveAuthAccount(context: AuthRequestContext) {
  const { request, reply, identity, limiter, path } = context;
  const { authBody, resolvedUserId } = await resolveLogin(context);
  const accountEmail = limiter.account(authBody, request.headers.cookie);
  const accountUserId =
    (await identity.userIdForEmail?.(accountEmail ?? "")) ?? null;
  const limit = limiter.check(
    path,
    request.ip,
    authBody,
    request.headers.cookie,
  );
  if (limit !== undefined) {
    if (limit.first)
      await identity.audit?.({
        userId:
          limit.bucket === "account" ? (resolvedUserId ?? accountUserId) : null,
        action: "authentication.rate_limited",
      });
    return reply
      .header("retry-after", String(limit.retryAfter))
      .code(429)
      .send({ code: "TOO_MANY_REQUESTS", message: "Try again later" });
  }
  Object.assign(context, { authBody, resolvedUserId, accountUserId });
  return undefined;
}

async function resolveLogin(context: AuthRequestContext) {
  const { request, identity, path } = context;
  let authBody = request.body;
  let resolvedUserId: string | null = null;
  if (path === "/auth/sign-in/email" && request.method === "POST") {
    const submitted = z.object({ email: z.email() }).safeParse(request.body);
    if (
      submitted.success &&
      identity.resolveAddress &&
      typeof request.body === "object" &&
      request.body !== null &&
      !Array.isArray(request.body)
    ) {
      const resolved = await identity.resolveAddress(submitted.data.email);
      if (resolved) {
        resolvedUserId = resolved.id;
        authBody = {
          ...request.body,
          email: resolved.email,
        };
      }
    }
  }
  return { authBody, resolvedUserId };
}
