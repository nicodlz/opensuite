import type { AddressService } from "@opensuite/core/services/addresses";
import { createFixedWindow } from "./auth/fixed-window.ts";
import type { DomainService } from "./routes/domains.ts";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createAliasLimiter, networkBucket } from "./auth/alias-limits.ts";
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
  hasPendingFactor,
  hasTrustDevice,
  withoutSessionCookie,
} from "./auth/limits.ts";
import { z } from "zod";
import { router, type ApiContext } from "./routes/index.ts";
import type { Entitlements } from "./billing/entitlements.ts";
import type { StorageMeter } from "./billing/storage.ts";
import type { StripeBilling } from "./billing/stripe.ts";
import type { ClaimService } from "./billing/claims.ts";
import type { createWebhookProcessor } from "./billing/webhook.ts";

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
    /** Whether accounts may use this domain; defaults to `mailDomain` only. */
    readonly isMailDomain?: (domain: string | undefined) => Promise<boolean>;
    readonly actor?: (headers: Headers) => Promise<Actor | null>;
    readonly withPrimaryReservation?: (
      email: string,
      work: () => Promise<Response>,
    ) => Promise<Response | null>;
    readonly resolveAddress?: (
      email: string,
    ) => Promise<{ id: string; email: string } | null>;
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
  readonly addresses?: AddressService;
  readonly push?: NonNullable<ApiContext["push"]>;
  readonly pushCleanup?: NonNullable<ApiContext["pushCleanup"]>;
  readonly setupStatus?: ApiContext["setupStatus"];
  readonly entitlements?: Entitlements;
  readonly storageMeter?: StorageMeter;
  readonly internalToken?: string;
  readonly billing?: StripeBilling;
  readonly claims?: ClaimService;
  readonly webhook?: {
    secret: string;
    processor: ReturnType<typeof createWebhookProcessor>;
  };
}

const tokenDigest = (value: string) =>
  createHash("sha256").update(value).digest();

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
  const addressLimits = createAliasLimiter();
  const signInLookupLimit = createFixedWindow(Date.now, 10_000, true);
  const pushLimits = createFixedWindow();
  const checkoutLimits = createFixedWindow();
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
    if (rawPath === "/alias/random/new") return undefined;
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

  if (
    dependencies.billing !== undefined &&
    dependencies.webhook !== undefined
  ) {
    const stripe = dependencies.billing.client;
    const webhook = dependencies.webhook;
    await app.register((scope, _options, done) => {
      scope.removeContentTypeParser("application/json");
      scope.addContentTypeParser(
        "application/json",
        { parseAs: "buffer", bodyLimit: 65_536 },
        (_request, body, parseDone) => parseDone(null, body),
      );
      scope.post(
        "/billing/webhook",
        { bodyLimit: 65_536 },
        async (request, reply) => {
          const signature = request.headers["stripe-signature"];
          if (typeof signature !== "string" || !Buffer.isBuffer(request.body))
            return reply.code(400).send({ code: "BAD_SIGNATURE" });
          let event;
          try {
            event = stripe.webhooks.constructEvent(
              request.body,
              signature,
              webhook.secret,
            );
          } catch {
            return reply.code(400).send({ code: "BAD_SIGNATURE" });
          }
          try {
            await webhook.processor.process(event);
            return { received: true };
          } catch (error) {
            const code =
              typeof error === "object" &&
              error !== null &&
              "code" in error &&
              typeof error.code === "string" &&
              /^[a-z0-9_]{1,80}$/.test(error.code)
                ? error.code
                : null;
            request.log.error(
              { eventId: event.id, eventType: event.type, stripeCode: code },
              "billing webhook failed",
            );
            return reply.code(500).send({ code: "PROCESSING_FAILED" });
          }
        },
      );
      done();
    });
  }

  const internalAuthorized = (authorization: string | undefined) =>
    dependencies.internalToken !== undefined &&
    timingSafeEqual(
      tokenDigest(authorization ?? ""),
      tokenDigest(`Bearer ${dependencies.internalToken}`),
    );
  app.get("/internal/storage/:userId", async (request, reply) => {
    if (!internalAuthorized(request.headers.authorization))
      return reply.code(401).send({ code: "UNAUTHORIZED" });
    if (
      dependencies.entitlements === undefined ||
      dependencies.storageMeter === undefined
    )
      return reply.code(503).send({ code: "SERVICE_UNAVAILABLE" });
    const { userId } = z
      .object({ userId: z.string().min(1).max(200) })
      .parse(request.params);
    try {
      const entitlement = await dependencies.entitlements.get(userId);
      const mailBytes =
        entitlement.quotaBytes === null
          ? 0
          : await dependencies.storageMeter.mailBytes(userId);
      reply.header("cache-control", "no-store");
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
    const { userId } = z
      .object({ userId: z.string().min(1).max(200) })
      .parse(request.params);
    try {
      await dependencies.storageMeter.refresh(userId);
      return { refreshed: true };
    } catch {
      return reply.code(503).send({ code: "SERVICE_UNAVAILABLE" });
    }
  });

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
        let authBody = request.body;
        let resolvedUserId: string | null = null;
        if (path === "/auth/sign-in/email" && request.method === "POST") {
          const submitted = z
            .object({ email: z.email() })
            .safeParse(request.body);
          if (
            submitted.success &&
            identity.resolveAddress &&
            typeof request.body === "object" &&
            request.body !== null &&
            !Array.isArray(request.body)
          ) {
            const resolved = await identity.resolveAddress(
              submitted.data.email,
            );
            if (resolved) {
              resolvedUserId = resolved.id;
              authBody = {
                ...request.body,
                email: resolved.email,
              };
            }
          }
        }
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
                limit.bucket === "account"
                  ? (resolvedUserId ?? accountUserId)
                  : null,
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
        if (path === "/auth/get-session" && pendingFactor)
          return reply.send(null);
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
          )
            return reply.code(400).send({
              code: "BAD_REQUEST",
              message: "Invalid or expired sign-in link",
            });
        }
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
          (identity.isMailDomain !== undefined ||
            identity.mailDomain !== undefined)
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
        if (path === "/auth/get-session" && actor === null)
          return reply.send(null);
        const auditUserId = actor?.id ?? resolvedUserId ?? accountUserId;
        const body =
          request.method === "GET" || request.method === "HEAD"
            ? undefined
            : JSON.stringify(authBody);
        if (path === "/auth/sign-out" && pendingFactor) {
          const cancelled = await identity.handler(
            new Request(
              new URL("/api/auth/two-factor/cancel", identity.publicOrigin),
              { method: "POST", headers, body: "{}" },
            ),
          );
          if (!cancelled.ok)
            return reply.code(503).send({
              code: "UNAVAILABLE",
              message: "Could not cancel sign-in",
            });
        }
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
          const adminSignUp = identity.handler.adminSignUp;
          const create = () => adminSignUp(signup.data);
          const reserved = identity.withPrimaryReservation
            ? await identity.withPrimaryReservation(signup.data.email, create)
            : await create();
          if (!reserved)
            return reply
              .code(409)
              .send({ code: "CONFLICT", message: "Address unavailable" });
          response = reserved;
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
        if (path === "/auth/sign-in/email") limiter.remember(authBody, cookies);
        const actions: Readonly<Record<string, string>> = {
          "/auth/sign-up/email": "sign_up",
          "/auth/sign-in/email": "sign_in",
          "/auth/two-factor/enable": "mfa.enrol",
          "/auth/two-factor/verify-totp": "mfa.verify",
          "/auth/two-factor/verify-backup-code": "mfa.verify",
          "/auth/two-factor/verify-security-key": "mfa.verify",
          "/auth/security-keys/register": "mfa.key.add",
          "/auth/security-keys/register-options": "mfa.key.enrol_options",
          "/auth/security-keys/remove": "mfa.key.remove",
          "/auth/two-factor/disable": "mfa.totp.remove",
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
            userId: auditUserId,
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
            (path === "/auth/security-keys/remove" ||
              path === "/auth/two-factor/disable") &&
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
    if (
      ["/origins", "/push/public-key", "/push/privacy"].includes(
        request.url.split("?")[0] ?? "",
      )
    )
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
        entitlements: dependencies.entitlements,
        storageMeter: dependencies.storageMeter,
        billing: dependencies.billing,
        claims: dependencies.claims,
        publicCheckoutLimit: () =>
          checkoutLimits.consume(`checkout:${request.ip}`, 10, 60_000) ===
            undefined &&
          checkoutLimits.consume("checkout:global", 100, 60_000) === undefined,
        signedBillingLimit: (userId) =>
          checkoutLimits.consume(`billing-user:${userId}`, 10, 60_000) ===
          undefined,
        claimLimit: (kind) =>
          (kind !== "status" ||
            checkoutLimits.consume("status:global", 600, 60_000) ===
              undefined) &&
          checkoutLimits.consume(
            `${kind}:${request.ip}`,
            kind === "status" ? 60 : 10,
            60_000,
          ) === undefined,
        push: dependencies.push,
        pushCleanup: dependencies.pushCleanup ?? dependencies.push?.store,
        pushSubscribeLimit: (userId) =>
          pushLimits.consume(`subscribe:${userId}`, 10, 60_000) === undefined,
        pushTestLimit: (userId) =>
          pushLimits.consume(`test:${userId}`, 5, 60_000) === undefined,
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
        addresses: dependencies.addresses,
        addressMutationLimit: (userId) => addressLimits.mutate(userId),
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
