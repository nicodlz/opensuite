import { requestHeaders } from "../auth/request-headers.ts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { mailContext, type ApiContext } from "./context.ts";
import type { ServerDependencies } from "./server-dependencies.ts";
import type { Actor } from "@opensuite/core/services/accounts";
import { createFixedWindow } from "../auth/fixed-window.ts";
import type { createAliasLimiter } from "../auth/alias-limits.ts";
import type { registerDownloads } from "./downloads.ts";
import type { registerOpenApi } from "./openapi.ts";
export function registerDispatch(
  app: FastifyInstance,
  dependencies: ServerDependencies,
  actors: WeakMap<FastifyRequest, Actor | null>,
  downloads: ReturnType<typeof registerDownloads>,
  handler: Awaited<ReturnType<typeof registerOpenApi>>,
  startedAt: number,
  aliasLimits: ReturnType<typeof createAliasLimiter>,
  addressLimits: ReturnType<typeof createAliasLimiter>,
) {
  const pushLimits = createFixedWindow();
  const checkoutLimits = createFixedWindow();
  const handleApi = async (request: FastifyRequest, reply: FastifyReply) => {
    // The origin map decides cross-origin navigation; never let a browser
    // or intermediary keep an old copy.
    if (
      ["/origins", "/push/public-key", "/push/privacy"].includes(
        request.url.split("?")[0] ?? "",
      )
    )
      void reply.header("cache-control", "no-store");
    const headers = requestHeaders(request);
    const actor =
      actors.get(request) ??
      (await dependencies.identity?.actor?.(headers)) ??
      null;
    const { matched } = await handler.handle(request, reply, {
      context: createApiContext(
        request,
        actor,
        dependencies,
        downloads,
        startedAt,
        aliasLimits,
        addressLimits,
        pushLimits,
        checkoutLimits,
      ),
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
}

function createApiContext(
  request: FastifyRequest,
  actor: Actor | null,
  dependencies: ServerDependencies,
  downloads: ReturnType<typeof registerDownloads>,
  startedAt: number,
  aliasLimits: ReturnType<typeof createAliasLimiter>,
  addressLimits: ReturnType<typeof createAliasLimiter>,
  pushLimits: ReturnType<typeof createFixedWindow>,
  checkoutLimits: ReturnType<typeof createFixedWindow>,
): ApiContext {
  return {
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
        checkoutLimits.consume("status:global", 600, 60_000) === undefined) &&
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
    ...mailContext(dependencies),
    contacts: dependencies.contacts,
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
  };
}
