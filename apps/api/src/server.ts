import type { ReadinessService } from "@opensuite/core/services/readiness";
import type { AccountService, Actor } from "@opensuite/core/services/accounts";
import { OpenAPIGenerator } from "@orpc/openapi";
import { OpenAPIHandler } from "@orpc/openapi/fastify";
import { ORPCError, onError } from "@orpc/server";
import { ZodToJsonSchemaConverter } from "@orpc/zod/zod4";
import Fastify, { type FastifyInstance } from "fastify";
import type { ApiConfig } from "./config.ts";
import { createAuthLimiter } from "./auth/limits.ts";
import { router, type ApiContext } from "./routes/index.ts";

export interface ServerDependencies {
  readonly config: Pick<ApiConfig, "logLevel">;
  readonly readiness: ReadinessService;
  readonly monotonicMs: () => number;
  readonly identity?: {
    readonly handler: (request: Request) => Promise<Response>;
    readonly publicOrigin: string;
    readonly actor?: (headers: Headers) => Promise<Actor | null>;
    readonly userIdForEmail?: (email: string) => Promise<string | null>;
    readonly audit?: (event: {
      userId: string | null;
      action: string;
    }) => Promise<void>;
  };
  readonly accounts?: AccountService;
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
    const limiter = createAuthLimiter();
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
      const actor = (await identity.actor?.(headers)) ?? null;
      const accountEmail = limiter.account(
        request.body,
        request.headers.cookie,
        actor?.email,
      );
      const auditUserId =
        actor?.id ??
        (accountEmail === undefined
          ? null
          : ((await identity.userIdForEmail?.(accountEmail)) ?? null));
      const retryAfter = limiter.check(
        request.url.split("?")[0] ?? "",
        request.ip,
        request.body,
        request.headers.cookie,
        actor?.email,
      );
      if (retryAfter !== undefined) {
        await identity.audit?.({
          userId: auditUserId,
          action: "authentication.rate_limited",
        });
        return reply
          .header("retry-after", String(retryAfter))
          .code(429)
          .send({ code: "TOO_MANY_REQUESTS", message: "Try again later" });
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
      if (request.url.split("?")[0] === "/auth/sign-in/email")
        limiter.remember(request.body, cookies);
      const path = request.url.split("?")[0];
      const actions: Readonly<Record<string, string>> = {
        "/auth/sign-in/email": "sign_in",
        "/auth/two-factor/enable": "mfa.enrol",
        "/auth/two-factor/verify-totp": "mfa.verify",
        "/auth/two-factor/verify-backup-code": "mfa.verify",
        "/auth/two-factor/disable": "mfa.disable",
        "/auth/revoke-session": "session.revoke",
        "/auth/revoke-sessions": "session.revoke_all",
        "/auth/revoke-other-sessions": "session.revoke_others",
        "/auth/sign-out": "session.revoke",
      };
      const action = path === undefined ? undefined : actions[path];
      if (action !== undefined) {
        const responseBody: unknown = await response
          .clone()
          .json()
          .catch(() => null);
        const challenge =
          typeof responseBody === "object" &&
          responseBody !== null &&
          "twoFactorRedirect" in responseBody &&
          responseBody.twoFactorRedirect === true;
        await identity.audit?.({
          userId: auditUserId,
          action: `${action}.${response.ok ? (challenge ? "challenge" : "success") : "failure"}`,
        });
      }
      if (cookies.length > 0) reply.header("set-cookie", cookies);
      return reply.send(await response.text());
    });
  }

  app.all("/*", async (request, reply) => {
    if (
      dependencies.identity !== undefined &&
      request.method !== "GET" &&
      request.method !== "HEAD" &&
      request.headers.origin !== dependencies.identity.publicOrigin
    ) {
      return reply
        .code(403)
        .send({ code: "FORBIDDEN", message: "Invalid origin" });
    }
    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers)) {
      if (value === undefined) continue;
      if (Array.isArray(value))
        for (const part of value) headers.append(name, part);
      else headers.set(name, value);
    }
    const actor = (await dependencies.identity?.actor?.(headers)) ?? null;
    const { matched } = await handler.handle(request, reply, {
      context: {
        actor,
        accounts: dependencies.accounts,
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
