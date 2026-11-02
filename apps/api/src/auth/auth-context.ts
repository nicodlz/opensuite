import type { FastifyReply, FastifyRequest } from "fastify";
import type { Actor } from "@opensuite/core/services/accounts";
import type { ServerDependencies } from "../routes/server-dependencies.ts";
import type { createAuthLimiter } from "./limits.ts";
import type { createFixedWindow } from "./fixed-window.ts";
import type { createHandoffRegistry } from "./handoff.ts";

export interface AuthRequestContext {
  request: FastifyRequest;
  reply: FastifyReply;
  dependencies: ServerDependencies;
  identity: NonNullable<ServerDependencies["identity"]>;
  limiter: ReturnType<typeof createAuthLimiter>;
  handoffs: ReturnType<typeof createHandoffRegistry>;
  signInLookupLimit: ReturnType<typeof createFixedWindow>;
  url: URL;
  path: string;
  pendingFactor: boolean;
  authBody: unknown;
  resolvedUserId: string | null;
  accountUserId: string | null;
  headers: Headers;
  actor: Actor | null;
}
