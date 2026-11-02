import { requestHeaders } from "./request-headers.ts";
import { z } from "zod";
import type { AuthRequestContext } from "./auth-context.ts";
import { withoutSessionCookie } from "./limits.ts";

export async function authenticateRequest(context: AuthRequestContext) {
  const { reply, identity, limiter, path } = context;
  const headers = prepareAuthHeaders(context);
  if (headers === undefined) return reply;
  const actor = (await identity.actor?.(headers)) ?? null;
  const reauthLimit = limiter.reauthenticate(path, actor?.id);
  if (reauthLimit) {
    if (reauthLimit.first)
      await identity.audit?.({
        userId: actor?.id ?? null,
        action: "authentication.rate_limited",
      });
    return reply
      .header("retry-after", String(reauthLimit.retryAfter))
      .code(429)
      .send({ code: "TOO_MANY_REQUESTS", message: "Try again later" });
  }
  Object.assign(context, { headers, actor });
  return undefined;
}

function prepareAuthHeaders(context: AuthRequestContext): Headers | undefined {
  const { request, reply, handoffs, path, pendingFactor } = context;
  const headers = requestHeaders(request, ["host", "content-length"]);
  if (path === "/auth/get-session" && pendingFactor) {
    void reply.send(null);
    return undefined;
  }
  if (path.startsWith("/auth/two-factor/") && pendingFactor) {
    const cookie = headers.get("cookie");
    if (cookie) headers.set("cookie", withoutSessionCookie(cookie));
  }
  if (path === "/auth/one-time-token/verify") {
    const token = z
      .object({ token: z.string().min(16).max(256) })
      .safeParse(request.body);
    if (
      request.method !== "POST" ||
      !token.success ||
      !handoffs.consume(token.data.token, request.headers.origin ?? "")
    ) {
      void reply.code(400).send({
        code: "BAD_REQUEST",
        message: "Invalid or expired sign-in link",
      });
      return undefined;
    }
  }
  return headers;
}

export async function authorizeAuthRequest(context: AuthRequestContext) {
  const { request, reply, dependencies, path, actor } = context;
  // Direct authentication sign-outs must also stop delivery to every
  // subscription bound to this session, including sibling origins.
  if (
    path === "/auth/sign-out" &&
    request.method === "POST" &&
    actor?.sessionId
  ) {
    // Best effort: a cleanup failure must never block signing out.
    await (dependencies.pushCleanup ?? dependencies.push?.store)
      ?.unsubscribeSession(actor.id, actor.sessionId)
      .catch(() => request.log.warn("push session cleanup failed"));
  }
  await authorizeSignup(context);
  if (path === "/auth/get-session" && actor === null) return reply.send(null);
  return undefined;
}

async function authorizeSignup(context: AuthRequestContext) {
  const { request, reply, identity, path, actor } = context;
  if (path === "/auth/sign-up/email" && actor?.role !== "admin") {
    await identity.audit?.({
      userId: actor?.id ?? null,
      action: "sign_up.failure",
    });
    return reply
      .code(403)
      .send({ code: "FORBIDDEN", message: "Administrator required" });
  }
  if (
    path === "/auth/sign-up/email" &&
    (identity.isMailDomain !== undefined || identity.mailDomain !== undefined)
  ) {
    const email = z.object({ email: z.email() }).safeParse(request.body);
    const domain = email.success
      ? email.data.email.toLowerCase().split("@")[1]
      : undefined;
    if (
      !email.success ||
      !(identity.isMailDomain === undefined
        ? domain === identity.mailDomain
        : await identity.isMailDomain(domain))
    )
      return reply.code(400).send({
        code: "BAD_REQUEST",
        message: "Email domain is not configured for signup",
      });
  }
  return undefined;
}
