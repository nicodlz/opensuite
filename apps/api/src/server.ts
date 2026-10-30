import type { DomainService } from "./routes/domains.ts";
import { randomBytes } from "node:crypto";
import { createAliasLimiter } from "./auth/alias-limits.ts";
import type { AliasService } from "@opensuite/core/services/aliases";
import { registerAliasCompat } from "./routes/alias-compat.ts";
import type { CalendarService } from "@opensuite/core/services/calendar";
import type { MailService } from "@opensuite/core/services/mail";
import type { ReadinessService } from "@opensuite/core/services/readiness";
import type { AccountService, Actor } from "@opensuite/core/services/accounts";
import { OpenAPIGenerator } from "@orpc/openapi";
import { OpenAPIHandler } from "@orpc/openapi/fastify";
import { ORPCError, onError } from "@orpc/server";
import { ZodToJsonSchemaConverter } from "@orpc/zod/zod4";
import Fastify, {
  LogController,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import type { ApiConfig } from "./config.ts";
import { createVaultStatus } from "./routes/vault-status.ts";
import { createHandoffRegistry } from "./auth/handoff.ts";
import {
  createAuthLimiter,
  hasDuplicateAuthCookie,
  legacyAuthCookies,
} from "./auth/limits.ts";
import { z } from "zod";
import { router, type ApiContext } from "./routes/index.ts";

const hasPendingFactor = (cookie: string | undefined) =>
  (cookie ?? "")
    .split(";")
    .some((part) => /^__Host-opensuite\.two_factor=.+$/.test(part.trim()));

export interface ServerDependencies {
  readonly config: Pick<ApiConfig, "logLevel"> & {
    readonly trustProxy?: string;
  };
  readonly vaultOrigin?: string;
  readonly vaultStatusOptions?: Parameters<typeof createVaultStatus>[1];
  readonly readiness: ReadinessService;
  readonly monotonicMs: () => number;
  readonly identity?: {
    readonly handler: ((request: Request) => Promise<Response>) & {
      readonly adminSignUp?: (body: {
        name: string;
        email: string;
        password: string;
      }) => Promise<Response>;
    };
    readonly publicOrigin: string;
    /** Exact origins allowed to send state-changing requests. */
    readonly trustedOrigins?: readonly string[];
    readonly productOrigins?: Readonly<Record<string, string>>;
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
  readonly calendar?: CalendarService;
  readonly domains?: DomainService;
  readonly aliases?: AliasService;
  readonly setupStatus?: ApiContext["setupStatus"];
}

export const buildServer = async (
  dependencies: ServerDependencies,
): Promise<FastifyInstance> => {
  const app = Fastify({
    bodyLimit: 1_000_000,
    logger: {
      level: dependencies.config.logLevel,
      redact: [
        "req.headers.authentication",
        "req.headers.authorization",
        "req.headers.cookie",
        "request.headers.authentication",
        "request.headers.authorization",
        "request.headers.cookie",
      ],
    },
    logController: new LogController({ disableRequestLogging: true }),
    trustProxy: dependencies.config.trustProxy ?? false,
  });
  const startedAt = dependencies.monotonicMs();
  const aliasLimits = createAliasLimiter();
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
  const actors = new WeakMap<FastifyRequest, Actor | null>();
  app.addHook("onRequest", async (request, reply) => {
    const identity = dependencies.identity;
    const rawPath = request.url.split("?")[0] ?? "";
    if (rawPath === "/alias/random/new") return undefined;
    if (
      identity !== undefined &&
      (rawPath.startsWith("/auth/") || rawPath.startsWith("/api/auth/"))
    ) {
      const normalized = new URL(request.url, identity.publicOrigin).pathname;
      if (
        rawPath !== normalized ||
        rawPath.includes("%") ||
        rawPath.includes("//") ||
        rawPath
          .split("/")
          .some((segment) => segment === "." || segment === "..")
      ) {
        return reply.code(400).send({
          code: "BAD_REQUEST",
          message: "Invalid authentication path",
        });
      }
    }
    if (
      identity !== undefined &&
      hasDuplicateAuthCookie(request.headers.cookie)
    )
      return reply.code(400).send({
        code: "BAD_REQUEST",
        message: "Duplicate authentication cookie",
      });
    const pendingFactor = hasPendingFactor(request.headers.cookie);
    if (
      identity !== undefined &&
      pendingFactor &&
      !rawPath.startsWith("/auth/") &&
      !rawPath.startsWith("/api/auth/")
    )
      return reply.code(401).send({
        code: "UNAUTHORIZED",
        message: "Complete two-factor authentication",
      });
    if (
      identity !== undefined &&
      request.method !== "GET" &&
      request.method !== "HEAD" &&
      !(identity.trustedOrigins ?? [identity.publicOrigin]).includes(
        request.headers.origin ?? "",
      )
    ) {
      return reply
        .code(403)
        .send({ code: "FORBIDDEN", message: "Invalid origin" });
    }
    if (request.method === "POST" && rawPath === "/mail/attachments/upload") {
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) {
        if (value === undefined) continue;
        if (Array.isArray(value))
          for (const part of value) headers.append(name, part);
        else headers.set(name, value);
      }
      const actor = (await identity?.actor?.(headers)) ?? null;
      if (actor === null)
        return reply
          .code(401)
          .send({ code: "UNAUTHORIZED", message: "Unauthorized" });
      actors.set(request, actor);
    }
    return undefined;
  });
  const tokens = new Map<
    string,
    { userId: string; accountId: string; blobId: string; expires: number }
  >();
  const sweepTokens = () => {
    const now = Date.now();
    for (const [key, token] of tokens)
      if (token.expires <= now) tokens.delete(key);
  };
  const tokenTimer = setInterval(sweepTokens, 60_000);
  tokenTimer.unref();
  app.addHook("onClose", (_app, done) => {
    clearInterval(tokenTimer);
    done();
  });
  const downloads = {
    issue(userId: string, accountId: string, blobId: string) {
      const now = Date.now();
      sweepTokens();
      if (tokens.size >= 5000) {
        const oldest = tokens.keys().next().value;
        if (oldest !== undefined) tokens.delete(oldest);
      }
      const origin = dependencies.identity?.publicOrigin;
      if (origin === undefined)
        throw new ORPCError("UPSTREAM_UNAVAILABLE", {
          status: 503,
          defined: true,
        });
      const token = randomBytes(32).toString("base64url");
      const expires = now + 60_000;
      tokens.set(token, { userId, accountId, blobId, expires });
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
      if (token === undefined) return reply.code(404).send();
      if (token.expires <= Date.now()) {
        tokens.delete(request.params.token);
        return reply.code(404).send();
      }
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
      if (tokens.get(request.params.token) !== token)
        return reply.code(404).send();
      tokens.delete(request.params.token);
      if (token.expires <= Date.now()) return reply.code(404).send();
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
                    : [`at ${frame[1]} (${frame[2]}:${frame[3]}:${frame[4]})`];
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

  await app.register(registerAliasCompat, {
    aliases: dependencies.aliases,
    limiter: aliasLimits,
  });

  const vaultStatus = createVaultStatus(
    dependencies.vaultOrigin,
    dependencies.vaultStatusOptions,
  );
  app.get("/vault/status", async (request, reply) => {
    reply.header("cache-control", "no-store");
    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers)) {
      if (value === undefined) continue;
      if (Array.isArray(value))
        for (const part of value) headers.append(name, part);
      else headers.set(name, value);
    }
    const actor = (await dependencies.identity?.actor?.(headers)) ?? null;
    const { version, ...status } = await vaultStatus();
    return actor === null
      ? { enabled: status.enabled, reachable: status.reachable }
      : { ...status, version };
  });

  if (dependencies.identity !== undefined) {
    const identity = dependencies.identity;
    const limiter = createAuthLimiter();
    const handoffs = createHandoffRegistry();
    const siblings = new Set(
      Object.values(identity.productOrigins ?? {}).filter(
        (origin) => origin !== identity.publicOrigin,
      ),
    );
    // The sign-in origin issues a token for one listed sibling application.
    // The token returns in a URL fragment and is redeemed by that origin only.
    app.post("/session/handoff", async (request, reply) => {
      reply.header("cache-control", "no-store");
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
          z.object({ trustDevice: z.literal(true) }).safeParse(request.body)
            .success
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
        // A previously issued trusted-device cookie must never skip MFA.
        if (path === "/auth/sign-in/email") {
          const cookie = headers.get("cookie");
          if (cookie)
            headers.set(
              "cookie",
              cookie
                .split(";")
                .filter(
                  (part) =>
                    !part.trim().startsWith("__Host-opensuite.trust_device="),
                )
                .join(";"),
            );
        }
        if (path === "/auth/get-session" && pendingFactor)
          return reply.send(null);
        if (path.startsWith("/auth/two-factor/") && pendingFactor) {
          const cookie = headers.get("cookie");
          if (cookie)
            headers.set(
              "cookie",
              cookie
                .split(";")
                .filter(
                  (part) =>
                    !part.trim().startsWith("__Host-opensuite.session_token="),
                )
                .join(";"),
            );
        }
        if (path === "/auth/one-time-token/verify") {
          const token = z
            .object({ token: z.string().min(16).max(256) })
            .safeParse(request.body);
          if (
            request.method !== "POST" ||
            !token.success ||
            !handoffs.consume(token.data.token, request.headers.origin ?? "")
          )
            return reply.code(400).send({
              code: "BAD_REQUEST",
              message: "Invalid or expired sign-in link",
            });
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
        const body =
          request.method === "GET" || request.method === "HEAD"
            ? undefined
            : JSON.stringify(request.body);
        const signup = z
          .object({
            name: z.string().min(1),
            email: z.email(),
            password: z.string(),
          })
          .safeParse(request.body);
        let response: Response;
        if (path === "/auth/sign-up/email" && request.method === "POST") {
          if (!signup.success)
            return reply
              .code(400)
              .send({ code: "BAD_REQUEST", message: "Invalid signup data" });
          if (identity.handler.adminSignUp === undefined)
            return reply.code(503).send({
              code: "UPSTREAM_UNAVAILABLE",
              message: "Signup unavailable",
            });
          response = await identity.handler.adminSignUp(signup.data);
        } else {
          response = await identity.handler(
            new Request(url, {
              method: request.method,
              headers,
              ...(body === undefined ? {} : { body }),
            }),
          );
        }
        reply.code(response.status);
        for (const [name, value] of response.headers) {
          if (name !== "set-cookie" && name !== "content-length")
            reply.header(name, value);
        }
        const cookies = response.headers.getSetCookie();
        if (path === "/auth/sign-out" && pendingFactor)
          cookies.push(
            "__Host-opensuite.two_factor=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Lax",
          );
        if (path === "/auth/sign-in/email")
          limiter.remember(request.body, cookies);
        const actions: Readonly<Record<string, string>> = {
          "/auth/sign-up/email": "sign_up",
          "/auth/sign-in/email": "sign_in",
          "/auth/two-factor/enable": "mfa.enrol",
          "/auth/two-factor/verify-totp": "mfa.verify",
          "/auth/two-factor/verify-backup-code": "mfa.verify",
          "/auth/two-factor/verify-security-key": "mfa.verify",
          "/auth/security-keys/register": "mfa.key.add",
          "/auth/security-keys/remove": "mfa.key.remove",
          "/auth/two-factor/disable": "mfa.disable",
          "/auth/two-factor/generate-backup-codes":
            "mfa.backup_codes.regenerate",
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
            // Better Auth applies its own per-IP limit (3 sign-ins per 10 s
            // in production); a refusal there is not a wrong password.
            action: `${action}.${response.ok ? (challenge ? "challenge" : "success") : response.status === 429 ? "rate_limited" : "failure"}`,
          });
          if (
            response.ok &&
            path === "/auth/security-keys/register" &&
            z
              .object({ backupCodes: z.array(z.string()).min(1) })
              .safeParse(responseBody).success
          )
            await identity.audit?.({
              userId: auditUserId,
              action: "mfa.enrol.success",
            });
          if (
            response.ok &&
            path === "/auth/security-keys/remove" &&
            z
              .object({ twoFactorEnabled: z.literal(false) })
              .safeParse(responseBody).success
          )
            await identity.audit?.({
              userId: auditUserId,
              action: "mfa.disable.success",
            });
        }
        // Clear cookies left by the previous naming on this host. A cookie
        // planted for a parent domain is ignored by name and left alone.
        for (const name of legacyAuthCookies(request.headers.cookie))
          cookies.push(`${name}=; Max-Age=0; Path=/; Secure; HttpOnly`);
        if (cookies.length > 0) reply.header("set-cookie", cookies);
        // Never hand the session token itself to page scripts.
        if (path === "/auth/one-time-token/verify")
          return reply.send(response.ok ? { success: true } : null);
        return reply.send(await response.text());
      });
  }

  const handleApi = async (request: FastifyRequest, reply: FastifyReply) => {
    // The origin map decides cross-origin navigation; never let a browser
    // or intermediary keep an old copy.
    if (request.url.split("?")[0] === "/origins")
      reply.header("cache-control", "no-store");
    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers)) {
      if (value === undefined) continue;
      if (Array.isArray(value))
        for (const part of value) headers.append(name, part);
      else headers.set(name, value);
    }
    const actor =
      actors.get(request) ??
      (await dependencies.identity?.actor?.(headers)) ??
      null;
    const { matched } = await handler.handle(request, reply, {
      context: {
        actor,
        setupStatus: dependencies.setupStatus,
        setupIdentity: dependencies.identity,
        audit: dependencies.identity?.audit,
        mail: dependencies.mail,
        calendar: dependencies.calendar,
        productOrigins: dependencies.identity?.productOrigins ?? {},
        vaultOrigin: dependencies.vaultOrigin,
        downloads,
        accounts: dependencies.accounts,
        domains: dependencies.domains,
        aliases: dependencies.aliases,
        aliasCreationLimit: (userId) => aliasLimits.user(userId),
        aliasMutationLimit: (userId) => aliasLimits.mutate(userId),
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
  };
  app.post("/mail/attachments/upload", { bodyLimit: 70_000_000 }, handleApi);
  app.all("/*", handleApi);

  return app;
};
