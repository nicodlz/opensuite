import { requestHeaders } from "../auth/request-headers.ts";
import type { FastifyInstance } from "fastify";
import type { ServerDependencies } from "./server-dependencies.ts";
import { createVaultStatus } from "./vault-status.ts";
export function registerVault(
  app: FastifyInstance,
  dependencies: ServerDependencies,
) {
  const vaultStatus = createVaultStatus(
    dependencies.vaultOrigin,
    dependencies.vaultStatusOptions,
  );
  app.get("/vault/status", async (request, reply) => {
    void reply.header("cache-control", "no-store");
    const headers = requestHeaders(request);
    const actor = (await dependencies.identity?.actor?.(headers)) ?? null;
    const { version, ...status } = await vaultStatus();
    return actor === null
      ? { enabled: status.enabled, reachable: status.reachable }
      : { ...status, version };
  });
}
