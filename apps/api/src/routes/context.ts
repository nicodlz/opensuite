import type { NotificationDispatcher } from "@opensuite/core/services/notifications";
import type { createPushStore } from "@opensuite/db";
import type { AliasService } from "@opensuite/core/services/aliases";
import type { SetupStatus } from "@opensuite/contracts";
import type { DomainService } from "./domains.ts";
import type { AccountService, Actor } from "@opensuite/core/services/accounts";
import type { CalendarService } from "@opensuite/core/services/calendar";
import type { MailService } from "@opensuite/core/services/mail";
import type { ReadinessService } from "@opensuite/core/services/readiness";
import type { FastifyBaseLogger } from "fastify";

/** Per-request context handed to every procedure by the server. */
export interface ApiContext {
  readonly push:
    | {
        publicKey: string;
        store: ReturnType<typeof createPushStore>;
        dispatcher: NotificationDispatcher;
      }
    | undefined;
  readonly pushCleanup: ReturnType<typeof createPushStore> | undefined;
  readonly pushSubscribeLimit: (userId: string) => boolean;
  readonly pushTestLimit: (userId: string) => boolean;
  readonly setupStatus: (() => Promise<SetupStatus>) | undefined;
  readonly setupIdentity:
    | {
        readonly handler: (request: Request) => Promise<Response>;
        readonly publicOrigin: string;
        readonly mailDomain?: string;
        readonly isMailDomain?: (
          domain: string | undefined,
        ) => Promise<boolean>;
        readonly userIdForEmail?: (email: string) => Promise<string | null>;
      }
    | undefined;
  readonly mail: MailService | undefined;
  /** Public origin of each application when they are served separately. */
  readonly vaultOrigin?: string | undefined;
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
  readonly aliases: AliasService | undefined;
  readonly aliasCreationLimit: (userId: string) => boolean;
  readonly aliasMutationLimit: (userId: string) => boolean;
  readonly audit:
    | ((event: { userId: string | null; action: string }) => Promise<void>)
    | undefined;
  readonly accounts: AccountService | undefined;
  readonly log: FastifyBaseLogger;
  readonly readiness: ReadinessService;
  readonly uptimeSeconds: () => number;
}
