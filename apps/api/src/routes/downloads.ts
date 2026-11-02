import { requestHeaders } from "../auth/request-headers.ts";
import type { FastifyInstance } from "fastify";
import type { ServerDependencies } from "./server-dependencies.ts";
import { randomBytes } from "node:crypto";
import { ORPCError } from "@orpc/server";
type DownloadToken = {
  userId: string;
  accountId: string;
  blobId: string;
  expires: number;
};

export function registerDownloads(
  app: FastifyInstance,
  dependencies: ServerDependencies,
) {
  const tokens = new Map<string, DownloadToken>();
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
  registerDownloadRoute(app, dependencies, tokens);
  return downloads;
}

function registerDownloadRoute(
  app: FastifyInstance,
  dependencies: ServerDependencies,
  tokens: Map<string, DownloadToken>,
) {
  app.get<{ Params: { token: string } }>(
    "/mail/attachments/file/:token",
    async (request, reply) => {
      const token = tokens.get(request.params.token);
      if (token === undefined) return reply.code(404).send();
      if (token.expires <= Date.now()) {
        tokens.delete(request.params.token);
        return reply.code(404).send();
      }
      const headers = requestHeaders(request);
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
}
