import type { AccountService, Actor } from "@opensuite/core/services/accounts";
import type { MailService } from "@opensuite/core/services/mail";
import type { ReadinessService } from "@opensuite/core/services/readiness";
import type { FastifyBaseLogger } from "fastify";

/** Per-request context handed to every procedure by the server. */
export interface ApiContext {
  readonly mail: MailService | undefined;
  readonly downloads: {
    issue(
      userId: string,
      accountId: string,
      blobId: string,
    ): { url: string; expiresAt: string };
  };
  readonly actor: Actor | null;
  readonly accounts: AccountService | undefined;
  readonly log: FastifyBaseLogger;
  readonly readiness: ReadinessService;
  readonly uptimeSeconds: () => number;
}
