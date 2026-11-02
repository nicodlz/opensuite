import {
  reconcileOrganizerPending,
  scanOrganizerReplies,
} from "@opensuite/core/services/invitations/organizer-scan";
import {
  invitationProtocol,
  organizerProtocol,
} from "@opensuite/core/adapters/invitations";
import { createMailWithInvitations } from "@opensuite/core/services/invitations";
import {
  createOrganizerService,
  type OrganizerService,
} from "@opensuite/core/services/invitations-outbound";
import { createCalendarService } from "@opensuite/core/services/calendar";
import { guardOrganizedCalendar } from "@opensuite/core/services/invitations/organizer-calendar";
import type { MailCredentialStore } from "@opensuite/core/services/jmap-access";
import type {
  AliasService,
  createAliasService,
} from "@opensuite/core/services/aliases";
import type {
  AddressService,
  createAddressService,
} from "@opensuite/core/services/addresses";
import {
  createInvitationStore,
  createOrganizedInvitationStore,
  createOrganizedReplyScanStore,
  createPushStore,
  createMailPushStore,
  type PrismaClient,
  type OrganizedReplyScanStore,
  type OrganizedInvitationStore,
  type createMailboxStore,
  type createDomainStore,
} from "@opensuite/db";
import { createNotificationDispatcher } from "@opensuite/core/services/notifications";
import { createWebPushTransport } from "@opensuite/core/adapters/web-push";
import { loadVapidConfig, loadMailPushConfig } from "./config.ts";
import type { PushProduct } from "@opensuite/contracts";

/** Missing VAPID disables only push; no secret values enter diagnostics. */
export async function configurePush(
  env: Readonly<Record<string, string | undefined>>,
  db: PrismaClient,
  subject: string,
  warn: () => void,
  logFailure: (event: { product: PushProduct; status: number | null }) => void,
) {
  const vapid = await loadVapidConfig(env);
  if (vapid.isErr()) {
    warn();
    return undefined;
  }
  const store = createPushStore(db, vapid.value.publicKey);
  return {
    publicKey: vapid.value.publicKey,
    store,
    dispatcher: createNotificationDispatcher(
      store,
      createWebPushTransport(
        vapid.value.publicKey,
        vapid.value.privateKey,
        subject,
      ),
      () => new Date(),
      logFailure,
    ),
  };
}

import process from "node:process";
import type { FastifyInstance } from "fastify";
import type { DomainService } from "@opensuite/core/services/domains";
import type { createAuthRuntime } from "./auth/runtime.ts";
import type { StorageMeter } from "./billing/storage.ts";
import type { StripeBilling } from "./billing/stripe.ts";
import { startQuotaJob } from "./billing/quota-job.ts";
import { startCustomerMetadataJob } from "./billing/customer-job.ts";
import { startSubscriptionSync } from "./billing/subscription-sync.ts";
import { startMailNotifier } from "./adapters/mail-notifier.ts";
import { startCalendarReminderJob } from "./calendar-reminder-job.ts";
import { startDomainJob } from "./routes/domain-job.ts";

interface JobDependencies {
  app: FastifyInstance;
  db: PrismaClient;
  cloud: boolean;
  storageMeter: StorageMeter;
  stripeBilling: StripeBilling | undefined;
  push: Awaited<ReturnType<typeof configurePush>>;
  mailboxStore: Extract<
    ReturnType<typeof createMailboxStore>,
    { value: unknown }
  >["value"];
  domainStore: ReturnType<typeof createDomainStore>;
  domains: DomainService | undefined;
  mailDomains: readonly string[];
  origin: string;
  addresses: ReturnType<typeof createAddressService>;
  aliases: ReturnType<typeof createAliasService>;
  auth: ReturnType<typeof createAuthRuntime>;
  stopOrganizerReplyJob: () => Promise<void>;
}

function startBillingJobs({
  app,
  db,
  cloud,
  storageMeter,
  stripeBilling,
}: JobDependencies) {
  const stopQuotaJob = cloud
    ? startQuotaJob(db, storageMeter, () =>
        app.log.warn("mail quota refresh failed"),
      )
    : undefined;
  const stopCustomerJob =
    stripeBilling === undefined
      ? undefined
      : startCustomerMetadataJob(db, stripeBilling.client, () =>
          app.log.warn("billing customer synchronization failed"),
        );
  const stopSubscriptionSync =
    stripeBilling === undefined
      ? undefined
      : startSubscriptionSync(
          db,
          stripeBilling.client,
          storageMeter.refresh,
          () => app.log.warn("billing subscription synchronization failed"),
        );
  const stuckEventsTimer = setInterval(() => {
    void db.stripeEvent
      .count({
        where: {
          processedAt: null,
          receivedAt: { lt: new Date(Date.now() - 6 * 60 * 60 * 1000) },
        },
      })
      .then((count) => {
        if (count > 0)
          app.log.error(
            { count },
            "Stripe events unprocessed for over six hours",
          );
        return undefined;
      })
      .catch(() => app.log.warn("could not count stuck Stripe events"));
  }, 300_000);
  stuckEventsTimer.unref();
  return {
    stopQuotaJob,
    stopCustomerJob,
    stopSubscriptionSync,
    stuckEventsTimer,
  };
}
function startProductJobs({
  app,
  db,
  push,
  mailboxStore,
  domainStore,
  domains,
  mailDomains,
  origin,
}: JobDependencies) {
  const mailPushConfig = loadMailPushConfig(process.env);
  if (mailPushConfig.isErr())
    app.log.error(
      { issues: mailPushConfig.error.issues },
      "mail notifications disabled: invalid configuration",
    );
  const stopMailNotifier =
    push === undefined || mailPushConfig.isErr()
      ? undefined
      : startMailNotifier({
          store: createMailPushStore(db, push.publicKey),
          mailboxes: {
            getForOwner: async (userId, accountId) =>
              mailboxStore.getForOwner(userId, accountId),
          },
          origin: origin,
          dispatcher: push.dispatcher,
          options: mailPushConfig.value,
          log: () => app.log.warn("mail notification worker failed"),
        });
  const stopDomainJob =
    domains === undefined
      ? undefined
      : startDomainJob(
          domainStore,
          domains,
          process.env["DOMAINS_CHECK_INTERVAL_SECONDS"],
          () => app.log.warn("domain verification failed"),
          mailDomains,
        );
  const stopCalendarReminders =
    push === undefined
      ? undefined
      : startCalendarReminderJob({
          db: db,
          store: {
            getForOwner: async (userId, accountId) =>
              mailboxStore.getForOwner(userId, accountId),
          },
          origin: origin,
          dispatcher: push.dispatcher,
          publicKey: push.publicKey,
          onError: () => app.log.warn("calendar reminder job failed"),
        });
  return { stopMailNotifier, stopDomainJob, stopCalendarReminders };
}
function startReconciliation({
  app,
  addresses,
  aliases,
  auth,
}: JobDependencies) {
  let running: Promise<void> | undefined;
  const work = async () => {
    try {
      const configuredResult = await addresses.ensureDomains();
      if (configuredResult.isErr())
        app.log.warn("configured address domains incomplete");
      const addressResult = await addresses.reconcile();
      if (addressResult.isErr() || addressResult.value > 0)
        app.log.warn("address reconciliation incomplete");
      const aliasResult = await aliases.reconcile();
      if (aliasResult.isErr() || aliasResult.value > 0)
        app.log.warn("alias reconciliation incomplete");
      const failures = await auth.reconcile();
      if (failures > 0)
        app.log.warn({ failures }, "mailbox reconciliation incomplete");
    } catch {
      app.log.error("mailbox reconciliation failed");
    }
  };
  const reconcile = () => {
    if (running !== undefined) return running;
    running = work().finally(() => {
      running = undefined;
    });
    return running;
  };
  void reconcile();
  const timer = setInterval(() => {
    void reconcile();
  }, 60_000);
  return { timer, wait: () => running };
}
export function registerBackgroundJobs(dependencies: JobDependencies) {
  const { app, db } = dependencies;
  const {
    stopQuotaJob,
    stopCustomerJob,
    stopSubscriptionSync,
    stuckEventsTimer,
  } = startBillingJobs(dependencies);
  const { stopMailNotifier, stopDomainJob, stopCalendarReminders } =
    startProductJobs(dependencies);
  const { timer, wait } = startReconciliation(dependencies);
  app.addHook("onClose", async () => {
    clearInterval(timer);
    clearInterval(stuckEventsTimer);
    await stopQuotaJob?.();
    await stopCustomerJob?.();
    await stopSubscriptionSync?.();
    await stopDomainJob?.();
    await stopMailNotifier?.();
    await stopCalendarReminders?.();
    await wait();
    await dependencies.stopOrganizerReplyJob();
    await db.$disconnect();
  });
}

/** Keep lookup failures distinct from a confirmed loss of send authorization. */
export function createOrganizerAuthorization(
  aliases: Pick<AliasService, "canSendAs">,
  addresses: Pick<AddressService, "canSendAs">,
) {
  return async (userId: string, address: string) => {
    const alias = await aliases.canSendAs(userId, address);
    if (alias.isErr()) throw new Error("Alias authorization unavailable");
    if (alias.value) return `alias:${alias.value}`;
    const found = await addresses.canSendAs(userId, address);
    if (found.isErr()) throw new Error("Address authorization unavailable");
    return found.value ? `address:${found.value}` : null;
  };
}

export function createInvitationServices(input: {
  db: PrismaClient;
  store: MailCredentialStore;
  origin: string;
  aliases: Pick<AliasService, "canSendAs">;
  addresses: Pick<AddressService, "canSendAs">;
  beforeAliasSend: (userId: string, aliasId: string) => Promise<boolean>;
}) {
  const { db, store, origin, aliases, addresses, beforeAliasSend } = input;
  const intentions = createInvitationStore(db);
  const organized = createOrganizedInvitationStore(db);
  const scans = createOrganizedReplyScanStore(db);
  const { mail, invitations } = createMailWithInvitations({
    aliases,
    addresses,
    store,
    origin,
    protocol: invitationProtocol,
    intentions,
    beforeAliasSend,
  });
  const canSendOrganizer = createOrganizerAuthorization(aliases, addresses);
  const organizer = createOrganizerService({
    store,
    origin,
    protocol: invitationProtocol,
    organizerProtocol,
    scans,
    intentions,
    organized,
    canSendAs: canSendOrganizer,
    beforeAliasSend,
  });
  const calendar = guardOrganizedCalendar(
    createCalendarService({ store, origin }),
    store,
    organized,
    origin,
  );
  return { mail, invitations, organizer, calendar, scans, organized };
}

export function startOrganizerReplyJob(
  scans: OrganizedReplyScanStore,
  organized: OrganizedInvitationStore,
  service: OrganizerService,
  onError: () => void,
  audit?: (event: { userId: string | null; action: string }) => Promise<void>,
) {
  let running: Promise<void> | undefined;
  const tick = () => {
    if (running) return;
    running = (async () => {
      await reconcileOrganizerPending(organized, service).catch(onError);
      await scanOrganizerReplies(scans, service, audit).catch(onError);
    })().finally(() => {
      running = undefined;
    });
  };
  tick();
  const timer = setInterval(tick, 60_000);
  return async () => {
    clearInterval(timer);
    await running;
  };
}
