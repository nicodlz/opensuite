import type { ReadinessService } from "@opensuite/core/services/readiness";
import type { FastifyBaseLogger } from "fastify";

/** Per-request context handed to every procedure by the server. */
export interface ApiContext {
  readonly log: FastifyBaseLogger;
  readonly readiness: ReadinessService;
  readonly uptimeSeconds: () => number;
}
