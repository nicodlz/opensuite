import type { AddressService } from "@opensuite/core/services/addresses";
import type { AliasService } from "@opensuite/core/services/aliases";
import type { CalendarService } from "@opensuite/core/services/calendar";
import type { CalendarImportService } from "@opensuite/core/services/migration-calendar";
import type { MailService } from "@opensuite/core/services/mail";
import type { ReadinessService } from "@opensuite/core/services/readiness";
import type { AccountService, Actor } from "@opensuite/core/services/accounts";
import type { DomainService } from "./domains.ts";
import type { createVaultStatus } from "./vault-status.ts";
import type { ApiContext } from "./index.ts";
import type { Entitlements } from "../billing/entitlements.ts";
import type { StorageMeter } from "../billing/storage.ts";
import type { StripeBilling } from "../billing/stripe.ts";
import type { ClaimService } from "../billing/claims.ts";
import type { createWebhookProcessor } from "../billing/webhook.ts";

export interface ServerDependencies {
  readonly config: {
    readonly logLevel:
      "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";
  } & {
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
  readonly migrationMail?: ApiContext["migrationMail"];
  readonly migrationDirect?: ApiContext["migrationDirect"];
  readonly calendar?: CalendarService;
  readonly calendarImport?: CalendarImportService;
  readonly contacts?: NonNullable<ApiContext["contacts"]>;
  readonly invitations?: ApiContext["invitations"];
  readonly organizer?: ApiContext["organizer"];
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
