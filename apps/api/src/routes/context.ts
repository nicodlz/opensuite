import type { SetupStatus } from "@opensuite/contracts";
import type { DomainService } from "./domains.ts";
import type { AccountService, Actor } from "@opensuite/core/services/accounts";
import type { CalendarService } from "@opensuite/core/services/calendar";
import type { MailService } from "@opensuite/core/services/mail";
import type { ReadinessService } from "@opensuite/core/services/readiness";
import type { FastifyBaseLogger } from "fastify";

/** Per-request context handed to every procedure by the server. */
export interface ApiContext {
  readonly setupStatus: (() => Promise<SetupStatus>) | undefined;
  readonly setupIdentity:
    | {
        readonly handler: (request: Request) => Promise<Response>;
        readonly publicOrigin: string;
        readonly mailDomain?: string;
        readonly userIdForEmail?: (email: string) => Promise<string | null>;
      }
    | undefined;
  readonly mail: MailService | undefined;
  /** Public origin of each application when they are served separately. */
  readonly productOrigins: Readonly<Record<string, string>>;
  readonly calendar: CalendarService | undefined;
  readonly downloads: {
    issue(
      userId: string,
      accountId: string,
      blobId: string,
    ): { url: string; expiresAt: string };
  };
  readonly actor: Actor | null;
  readonly domains: DomainService | undefined;
  readonly audit:
    | ((event: { userId: string | null; action: string }) => Promise<void>)
    | undefined;
  readonly accounts: AccountService | undefined;
  readonly log: FastifyBaseLogger;
  readonly readiness: ReadinessService;
  readonly uptimeSeconds: () => number;
}
