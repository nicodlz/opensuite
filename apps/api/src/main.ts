import { createAddressService } from "@opensuite/core/services/addresses";
import { StalwartAdmin } from "@opensuite/jmap/admin";
import { err, ok } from "neverthrow";
import { timedFetch } from "./adapters/timed-fetch.ts";
import { entitledAddressLimit } from "./address-limit.ts";
import { createAliasService } from "@opensuite/core/services/aliases";
import {
  createAliasMail,
  createAliasSendGuard,
} from "./adapters/alias-mail.ts";
import { createReadinessService, httpProbe } from "@opensuite/core";
import {
  createDatabase,
  createDatabaseProbe,
  createDomainStore,
  createAliasStore,
  createAddressStore,
  createMailboxStore,
  createPushStore,
  createMailPushStore,
} from "@opensuite/db";
import { createCalendarService } from "@opensuite/core/services/calendar";
import { createMailService } from "@opensuite/core/services/mail";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import {
  loadApplicationDatabaseUrl,
  loadAuthConfig,
  loadConfig,
  loadMailPushConfig,
  loadBillingConfig,
} from "./config.ts";
import { startMailNotifier } from "./adapters/mail-notifier.ts";
import { createAuthRuntime } from "./auth/runtime.ts";
import { startDomainJob } from "./routes/domain-job.ts";
import { configureDomains } from "./routes/domain-setup.ts";
import { createSetupStatus } from "./routes/setup-status.ts";
import { buildServer } from "./server.ts";
import { startCalendarReminderJob } from "./calendar-reminder-job.ts";
import { configurePush } from "./push-runtime.ts";
import type { PushProduct } from "@opensuite/contracts";
import { createEntitlements } from "./billing/entitlements.ts";
import { createStorageMeter } from "./billing/storage.ts";
import { createStripeBilling } from "./billing/stripe.ts";
import { createClaimService } from "./billing/claims.ts";
import { createWebhookProcessor } from "./billing/webhook.ts";
import { startQuotaJob } from "./billing/quota-job.ts";
import { startSubscriptionSync } from "./billing/subscription-sync.ts";
import { startCustomerMetadataJob } from "./billing/customer-job.ts";

const config = loadConfig(process.env);
if (config.isErr()) {
  process.stderr.write(
    `${JSON.stringify({ level: "fatal", msg: "invalid configuration", issues: config.error.issues })}\n`,
  );
  process.exit(1);
}

const billingEnv = {
  ...process.env,
  BILLING_INTERNAL_TOKEN_FILE:
    process.env["BILLING_INTERNAL_TOKEN_OVERRIDE_FILE"] ||
    process.env["BILLING_INTERNAL_TOKEN_FILE"],
};
const billing = await loadBillingConfig(billingEnv);
if (billing.isErr()) {
  process.stderr.write(
    `${JSON.stringify({ level: "fatal", msg: "invalid billing configuration", issues: billing.error.issues })}\n`,
  );
  process.exit(1);
}
const monotonicMs = () => performance.now();
const url = await loadApplicationDatabaseUrl(process.env);
if (url.isErr()) {
  process.stderr.write(
    `${JSON.stringify({ level: "fatal", msg: "invalid database configuration", issues: url.error.issues })}\n`,
  );
  process.exit(1);
}
const database = createDatabase(url.value);
if (database.isErr()) {
  process.stderr.write(
    `${JSON.stringify({ level: "fatal", msg: "invalid database configuration" })}\n`,
  );
  process.exit(1);
}

const authConfig = await loadAuthConfig(process.env);
if (authConfig.isErr()) {
  process.stderr.write(
    `${JSON.stringify({ level: "fatal", msg: "invalid authentication configuration", issues: authConfig.error.issues })}\n`,
  );
  process.exit(1);
}
let logPushFailure = (event: {
  product: PushProduct;
  status: number | null;
}) => {
  process.stderr.write(
    `${JSON.stringify({ level: "warn", msg: "push delivery failed", ...event })}\n`,
  );
};
const push = await configurePush(
  process.env,
  database.value,
  authConfig.value.publicOrigin,
  () =>
    process.stderr.write(
      `${JSON.stringify({ level: "warn", msg: "VAPID secrets unavailable or invalid; push disabled" })}\n`,
    ),
  (event) => logPushFailure(event),
);
const pushCleanup = createPushStore(database.value);
const readiness = createReadinessService({
  probes: [
    createDatabaseProbe(database.value),
    httpProbe("mail-server", authConfig.value.mailReadyUrl),
  ],
  timeoutMs: config.value.readinessTimeoutMs,
  now: () => new Date(),
  monotonicMs,
});

const auth = createAuthRuntime(database.value, authConfig.value);
const internalToken =
  billing.value.mode === "cloud"
    ? billing.value.internalToken
    : billingEnv.BILLING_INTERNAL_TOKEN_FILE
      ? (await readFile(billingEnv.BILLING_INTERNAL_TOKEN_FILE, "utf8")).trim()
      : undefined;
if (internalToken !== undefined && internalToken.length < 32) {
  process.stderr.write("invalid billing internal token\n");
  process.exit(1);
}
const entitlements = createEntitlements(
  database.value,
  billing.value,
  config.value.aliasPerUserCap,
);
const driveOrigin = z
  .url()
  .refine((value) => {
    const parsedUrl = new URL(value);
    return (
      ["http:", "https:"].includes(parsedUrl.protocol) &&
      parsedUrl.origin === value
    );
  })
  .safeParse(process.env["BILLING_DRIVE_ORIGIN"] || "http://drive:3001");
if (!driveOrigin.success) {
  process.stderr.write("invalid billing Drive origin\n");
  process.exit(1);
}
const storageMeter = createStorageMeter(
  database.value,
  entitlements,
  auth.mailAdmin,
  driveOrigin.data,
  internalToken,
);
const stripeBilling =
  billing.value.mode === "cloud"
    ? createStripeBilling(
        database.value,
        billing.value,
        authConfig.value.publicOrigin,
        entitlements,
      )
    : undefined;
const claims =
  stripeBilling === undefined
    ? undefined
    : createClaimService(
        database.value,
        stripeBilling.client,
        authConfig.value.mailDomain,
        auth.claimSignUp,
        storageMeter.refresh,
      );
const webhookProcessor =
  stripeBilling === undefined
    ? undefined
    : createWebhookProcessor(
        database.value,
        stripeBilling.client,
        storageMeter.refresh,
        (eventId, eventType) => {
          process.stderr.write(
            `${JSON.stringify({ level: "error", msg: "unrecognized Stripe subscription", eventId, eventType })}\n`,
          );
        },
      );
const store = createMailboxStore(database.value, authConfig.value.mailboxKey);
if (store.isErr()) {
  process.stderr.write(
    `${JSON.stringify({ level: "fatal", msg: "invalid mail configuration" })}\n`,
  );
  process.exit(1);
}
const mailboxStore = store.value;
const aliasStore = createAliasStore(database.value);
const aliasMail = createAliasMail(
  {
    origin: authConfig.value.stalwartOrigin,
    password: authConfig.value.adminPassword,
    ...(authConfig.value.managementClientIp === undefined
      ? {}
      : { managementClientIp: authConfig.value.managementClientIp }),
  },
  {
    getForOwner: async (userId, accountId) =>
      mailboxStore.getForOwner(userId, accountId),
  },
);
const aliases = createAliasService(
  aliasStore,
  aliasMail,
  config.value.aliasPerUserCap,
  billing.value.mode === "cloud"
    ? async (userId) => (await entitlements.get(userId)).aliasLimit
    : undefined,
);
const addressStore = createAddressStore(
  database.value,
  authConfig.value.mailDomains,
);
const addressAdmin = new StalwartAdmin(
  authConfig.value.stalwartOrigin,
  {
    username: "management@opensuite.internal",
    password: authConfig.value.adminPassword,
  },
  {
    fetch: timedFetch(
      authConfig.value.managementClientIp
        ? { "X-Forwarded-For": authConfig.value.managementClientIp }
        : {},
    ),
  },
);
const addresses = createAddressService(
  addressStore,
  aliasMail,
  entitledAddressLimit(entitlements, config.value.addressPerUserCap),
  async () => {
    const result = await addressStore.ensureConfigured(async (name) => {
      const domain = await addressAdmin.createDomain(name);
      if (domain.isErr()) throw new Error("domain provisioning failed");
      return domain.value.id;
    });
    return result.isErr() ? err(result.error) : ok(undefined);
  },
  authConfig.value.mailDomains,
);
const createAliasGuard = createAliasSendGuard(aliases);
const mail = createMailService({
  store: {
    getForOwner: async (userId, accountId) =>
      mailboxStore.getForOwner(userId, accountId),
  },
  origin: authConfig.value.stalwartOrigin,
  canSendAs: async (userId, address) => {
    const result = await aliases.canSendAs(userId, address);
    if (result.isOk() && result.value) return `alias:${result.value}`;
    const found = await addresses.canSendAs(userId, address);
    return found.isOk() && found.value ? `address:${found.value}` : null;
  },
  beforeAliasSend: async (userId, id) =>
    id.startsWith("address:")
      ? true
      : createAliasGuard(userId, id.slice("alias:".length)),
});
const calendar = createCalendarService({
  store: {
    getForOwner: async (userId, accountId) =>
      mailboxStore.getForOwner(userId, accountId),
  },
  origin: authConfig.value.stalwartOrigin,
});
const domainStore = createDomainStore(database.value);
const domains = await configureDomains(process.env, domainStore);
const app = await buildServer({
  config: { ...config.value, trustProxy: authConfig.value.trustedProxyIp },
  readiness,
  monotonicMs,
  setupStatus: createSetupStatus({
    readiness,
    mailDomain: authConfig.value.mailDomain,
    ...(process.env["DOMAINS_SES_ENABLED"] === "true" &&
    process.env["DOMAINS_STALWART_ORIGIN"] &&
    process.env["DOMAINS_STALWART_USER"] &&
    process.env["DOMAINS_STALWART_PASSWORD_FILE"]
      ? {
          relayManagement: {
            origin: process.env["DOMAINS_STALWART_ORIGIN"],
            username: process.env["DOMAINS_STALWART_USER"],
            passwordFile: process.env["DOMAINS_STALWART_PASSWORD_FILE"],
          },
        }
      : {}),
    ...(process.env["SETUP_BACKUP_MARKER"] === undefined
      ? {}
      : { backupMarker: process.env["SETUP_BACKUP_MARKER"] }),
    backupMaxAgeSeconds: 93600,
  }),
  ...(authConfig.value.vaultOrigin === undefined
    ? {}
    : { vaultOrigin: authConfig.value.vaultOrigin }),
  identity: { ...auth.identity, resolveAddress: addressStore.resolveLogin },
  accounts: auth.accounts,
  ...(domains === undefined ? {} : { domains }),
  mail,
  calendar,
  aliases,
  entitlements,
  storageMeter,
  ...(internalToken === undefined ? {} : { internalToken }),
  ...(stripeBilling === undefined ||
  claims === undefined ||
  webhookProcessor === undefined ||
  billing.value.mode !== "cloud"
    ? {}
    : {
        billing: stripeBilling,
        claims,
        webhook: {
          secret: billing.value.webhookSecret,
          processor: webhookProcessor,
        },
      }),
  addresses,
  ...(push === undefined ? {} : { push }),
  pushCleanup,
});
logPushFailure = (event) => app.log.warn(event, "push delivery failed");
const stopQuotaJob =
  billing.value.mode === "cloud"
    ? startQuotaJob(database.value, storageMeter, () =>
        app.log.warn("mail quota refresh failed"),
      )
    : undefined;
const stopCustomerJob =
  stripeBilling === undefined
    ? undefined
    : startCustomerMetadataJob(database.value, stripeBilling.client, () =>
        app.log.warn("billing customer synchronization failed"),
      );
const stopSubscriptionSync =
  stripeBilling === undefined
    ? undefined
    : startSubscriptionSync(
        database.value,
        stripeBilling.client,
        storageMeter.refresh,
        () => app.log.warn("billing subscription synchronization failed"),
      );
const stuckEventsTimer = setInterval(() => {
  void database.value.stripeEvent
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
        store: createMailPushStore(database.value, push.publicKey),
        mailboxes: {
          getForOwner: async (userId, accountId) =>
            mailboxStore.getForOwner(userId, accountId),
        },
        origin: authConfig.value.stalwartOrigin,
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
      );
const stopCalendarReminders =
  push === undefined
    ? undefined
    : startCalendarReminderJob({
        db: database.value,
        store: {
          getForOwner: async (userId, accountId) =>
            mailboxStore.getForOwner(userId, accountId),
        },
        origin: authConfig.value.stalwartOrigin,
        dispatcher: push.dispatcher,
        publicKey: push.publicKey,
        onError: () => app.log.warn("calendar reminder job failed"),
      });
let running: Promise<void> | undefined;
const work = async () => {
  try {
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
app.addHook("onClose", async () => {
  clearInterval(timer);
  clearInterval(stuckEventsTimer);
  await stopQuotaJob?.();
  await stopCustomerJob?.();
  await stopSubscriptionSync?.();
  await stopDomainJob?.();
  await stopMailNotifier?.();
  await stopCalendarReminders?.();
  await running;
  await database.value.$disconnect();
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    app.log.info({ signal }, "shutting down");
    void app.close();
  });
}

await app.listen({ host: config.value.host, port: config.value.port });
