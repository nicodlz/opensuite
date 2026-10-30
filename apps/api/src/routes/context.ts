import type { AccountService, Actor } from "@opensuite/core/services/accounts";
import type { ReadinessService } from "@opensuite/core/services/readiness";
import type { FastifyBaseLogger } from "fastify";

/** Per-request context handed to every procedure by the server. */
export interface ApiContext {
  readonly actor: Actor | null;
  readonly audit:
    | ((event: { userId: string | null; action: string }) => Promise<void>)
    | undefined;
  readonly accounts: AccountService | undefined;
  readonly log: FastifyBaseLogger;
  readonly readiness: ReadinessService;
  readonly uptimeSeconds: () => number;
}
