import type { DomainService } from "./routes/domains.ts";
import { randomBytes } from "node:crypto";
import type { MailService } from "@opensuite/core/services/mail";
import type { ReadinessService } from "@opensuite/core/services/readiness";
import type { AccountService, Actor } from "@opensuite/core/services/accounts";
import { OpenAPIGenerator } from "@orpc/openapi";
import { OpenAPIHandler } from "@orpc/openapi/fastify";
import { ORPCError, onError } from "@orpc/server";
import { ZodToJsonSchemaConverter } from "@orpc/zod/zod4";
import Fastify, { LogController, type FastifyInstance } from "fastify";
import type { ApiConfig } from "./config.ts";
import { createAuthLimiter } from "./auth/limits.ts";
import { z } from "zod";
import { router, type ApiContext } from "./routes/index.ts";

export interface ServerDependencies {
  readonly config: Pick<ApiConfig, "logLevel"> & {
    readonly trustProxy?: string;
  };
  readonly readiness: ReadinessService;
  readonly monotonicMs: () => number;
  readonly identity?: {
    readonly handler: (request: Request) => Promise<Response>;
    readonly publicOrigin: string;
    readonly mailDomain?: string;
    readonly actor?: (headers: Headers) => Promise<Actor | null>;
    readonly userIdForEmail?: (email: string) => Promise<string | null>;
    readonly audit?: (event: {
      userId: string | null;
      action: string;
    }) => Promise<void>;
  };
  readonly accounts?: AccountService;
  readonly mail?: MailService;
  readonly domains?: DomainService;
  readonly setupStatus?: ApiContext["setupStatus"];
}

export const buildServer = async (
  dependencies: ServerDependencies,
): Promise<FastifyInstance> => {
  const app = Fastify({
    bodyLimit: 70_000_000,
    logger: { level: dependencies.config.logLevel },
    logController: new LogController({ disableRequestLogging: true }),
    trustProxy: dependencies.config.trustProxy ?? false,
  });
  const startedAt = dependencies.monotonicMs();
  app.addHook("onRequest", (request, reply, done) => {
    reply.header("x-request-id", request.id);
    done();
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
  const tokens = new Map<
    string,
    { userId: string; accountId: string; blobId: string; expires: number }
  >();
  const downloads = {
    issue(userId: string, accountId: string, blobId: string) {
      const now = Date.now();
      for (const [key, token] of tokens)
        if (token.expires <= now) tokens.delete(key);
      const token = randomBytes(32).toString("base64url");
      const expires = now + 60_000;
      tokens.set(token, { userId, accountId, blobId, expires });
      const origin = dependencies.identity?.publicOrigin;
      if (origin === undefined)
        throw new ORPCError("UPSTREAM_UNAVAILABLE", {
          status: 503,
          defined: true,
        });
      return {
        url: new URL(`/api/mail/attachments/file/${token}`, origin).toString(),
        expiresAt: new Date(expires).toISOString(),
      };
    },
  };
  app.get<{ Params: { token: string } }>(
    "/mail/attachments/file/:token",
    async (request, reply) => {
      const token = tokens.get(request.params.token);
      if (token === undefined || token.expires <= Date.now())
        return reply.code(404).send();
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) {
        if (value === undefined) continue;
        if (Array.isArray(value))
          for (const part of value) headers.append(name, part);
        else headers.set(name, value);
      }
      const actor = await dependencies.identity?.actor?.(headers);
      if (actor === undefined || actor === null) return reply.code(401).send();
      if (actor.id !== token.userId) return reply.code(403).send();
      if (dependencies.mail === undefined) return reply.code(503).send();
      const data = await dependencies.mail.download(
        actor,
        token.accountId,
        token.blobId,
      );
      if (data.isErr())
        return reply
          .code(
            data.error.kind === "forbidden"
              ? 403
              : data.error.kind === "not_found"
                ? 404
                : 503,
          )
          .send();
      return reply
        .header("Cache-Control", "private, no-store")
        .header("X-Content-Type-Options", "nosniff")
        .header("Content-Disposition", "attachment")
        .type("application/octet-stream")
        .send(Buffer.from(data.value));
    },
  );

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
        context.log.error("procedure failed");
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
    for (const route of ["/auth/*", "/api/auth/*"])
      app.all(route, async (request, reply) => {
        const path = (request.url.split("?")[0] ?? "").replace(
          /^\/api(?=\/auth\/)/,
          "",
        );
        if (path.includes("%") || path.includes("//"))
          return reply.code(400).send({
            code: "BAD_REQUEST",
            message: "Invalid authentication path",
          });
        if (
          request.method !== "GET" &&
          request.method !== "HEAD" &&
          request.headers.origin !== identity.publicOrigin
        ) {
          return reply
            .code(403)
            .send({ code: "FORBIDDEN", message: "Invalid origin" });
        }
        if (limiter.hasDuplicateChallenge(request.headers.cookie)) {
          return reply.code(400).send({
            code: "BAD_REQUEST",
            message: "Duplicate authentication cookie",
          });
        }
        const limit = limiter.check(
          path,
          request.ip,
          request.body,
          request.headers.cookie,
        );
        if (limit !== undefined) {
          if (limit.first)
            await identity.audit?.({
              userId: null,
              action: "authentication.rate_limited",
            });
          return reply
            .header("retry-after", String(limit.retryAfter))
            .code(429)
            .send({ code: "TOO_MANY_REQUESTS", message: "Try again later" });
        }
        const headers = new Headers();
        for (const [name, value] of Object.entries(request.headers)) {
          if (
            name === "host" ||
            name === "content-length" ||
            value === undefined
          )
            continue;
          if (Array.isArray(value)) {
            for (const part of value) headers.append(name, part);
          } else headers.set(name, value);
        }
        const actor = (await identity.actor?.(headers)) ?? null;
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
          identity.mailDomain !== undefined
        ) {
          const email = z.object({ email: z.email() }).safeParse(request.body);
          if (
            !email.success ||
            email.data.email.toLowerCase().split("@")[1] !== identity.mailDomain
          )
            return reply.code(400).send({
              code: "BAD_REQUEST",
              message: "Email domain is not configured for signup",
            });
        }
        if (path === "/auth/get-session" && actor === null)
          return reply.send(null);
        const accountEmail = limiter.account(
          request.body,
          request.headers.cookie,
        );
        const auditUserId =
          actor?.id ??
          (accountEmail === undefined
            ? null
            : ((await identity.userIdForEmail?.(accountEmail)) ?? null));
        const url = new URL(
          request.url.startsWith("/api/auth/")
            ? request.url
            : `/api${request.url}`,
          identity.publicOrigin,
        );
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
        if (path === "/auth/sign-in/email")
          limiter.remember(request.body, cookies);
        const actions: Readonly<Record<string, string>> = {
          "/auth/sign-up/email": "sign_up",
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
        const action = actions[path];
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
            userId:
              auditUserId ??
              (accountEmail === undefined
                ? null
                : ((await identity.userIdForEmail?.(accountEmail)) ?? null)),
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
        setupStatus: dependencies.setupStatus,
        setupIdentity: dependencies.identity,
        audit: dependencies.identity?.audit,
        mail: dependencies.mail,
        downloads,
        accounts: dependencies.accounts,
        domains: dependencies.domains,
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
