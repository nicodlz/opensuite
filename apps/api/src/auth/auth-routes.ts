import type { FastifyInstance, FastifyReply } from "fastify";
import type { ServerDependencies } from "../routes/server-dependencies.ts";
import { z } from "zod";
import { createFixedWindow } from "./fixed-window.ts";
import { createHandoffRegistry } from "./handoff.ts";
import { createAuthLimiter, hasPendingFactor } from "./limits.ts";
import { validateAuthRequest, resolveAuthAccount } from "./auth-initial.ts";
import {
  authenticateRequest,
  authorizeAuthRequest,
} from "./auth-authorization.ts";
import { executeAuthRequest } from "./auth-execute.ts";
import { sendAuthResponse } from "./auth-response.ts";
import type { AuthRequestContext } from "./auth-context.ts";

const responseSent = (reply: FastifyReply) => reply.sent;

export function registerAuthRoutes(
  app: FastifyInstance,
  dependencies: ServerDependencies,
) {
  const signInLookupLimit = createFixedWindow(Date.now, 10_000, true);
  if (dependencies.identity !== undefined) {
    const identity = dependencies.identity;
    const limiter = createAuthLimiter();
    const handoffs = createHandoffRegistry();
    registerHandoff(app, identity, handoffs);
    for (const route of ["/auth/*", "/api/auth/*"])
      app.all(route, async (request, reply) => {
        const url = new URL(
          request.url.startsWith("/api/auth/")
            ? request.url
            : `/api${request.url}`,
          identity.publicOrigin,
        );
        const path = url.pathname.replace(/^\/api(?=\/auth\/)/, "");
        const pendingFactor = hasPendingFactor(request.headers.cookie);
        const context: AuthRequestContext = {
          request,
          reply,
          dependencies,
          identity,
          limiter,
          handoffs,
          signInLookupLimit,
          url,
          path,
          pendingFactor,
          authBody: request.body,
          resolvedUserId: null,
          accountUserId: null,
          headers: new Headers(),
          actor: null,
        };
        await validateAuthRequest(context);
        if (responseSent(reply)) return reply;
        await resolveAuthAccount(context);
        if (responseSent(reply)) return reply;
        await authenticateRequest(context);
        if (responseSent(reply)) return reply;
        await authorizeAuthRequest(context);
        if (responseSent(reply)) return reply;
        const response = await executeAuthRequest(context);
        if (!(response instanceof Response)) return reply;
        return sendAuthResponse(context, response);
      });
  }
}

function registerHandoff(
  app: FastifyInstance,
  identity: NonNullable<ServerDependencies["identity"]>,
  handoffs: ReturnType<typeof createHandoffRegistry>,
) {
  const siblings = new Set(
    Object.values(identity.productOrigins ?? {}).filter(
      (origin) => origin !== identity.publicOrigin,
    ),
  );
  // The sign-in origin issues a token for one listed sibling application.
  // The token returns in a URL fragment and is redeemed by that origin only.
  app.post("/session/handoff", async (request, reply) => {
    void reply.header("cache-control", "no-store");
    if (request.headers.origin !== identity.publicOrigin)
      return reply
        .code(403)
        .send({ code: "FORBIDDEN", message: "Invalid origin" });
    const input = z.object({ target: z.string() }).safeParse(request.body);
    if (!input.success || !siblings.has(input.data.target))
      return reply
        .code(400)
        .send({ code: "BAD_REQUEST", message: "Unknown application" });
    const headers = new Headers();
    const cookie = request.headers.cookie;
    if (cookie !== undefined) headers.set("cookie", cookie);
    if (((await identity.actor?.(headers)) ?? null) === null)
      return reply
        .code(401)
        .send({ code: "UNAUTHORIZED", message: "Unauthorized" });
    const response = await identity.handler(
      new Request(
        new URL("/api/auth/one-time-token/generate", identity.publicOrigin),
        { headers },
      ),
    );
    const result = z
      .object({ token: z.string().min(16) })
      .safeParse(await response.json().catch(() => null));
    if (!response.ok || !result.success)
      return reply
        .code(response.status === 401 ? 401 : 503)
        .send({ code: "UNAVAILABLE", message: "Sign-in handoff failed" });
    handoffs.bind(result.data.token, input.data.target);
    return reply.send({ token: result.data.token });
  });
}
