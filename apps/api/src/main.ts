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
  createMailboxStore,
  createPushStore,
  createMailPushStore,
} from "@opensuite/db";
import { createCalendarService } from "@opensuite/core/services/calendar";
import { createMailService } from "@opensuite/core/services/mail";
import { performance } from "node:perf_hooks";
import process from "node:process";
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

const config = loadConfig(process.env);
if (config.isErr()) {
  process.stderr.write(
    `${JSON.stringify({ level: "fatal", msg: "invalid configuration", issues: config.error.issues })}\n`,
  );
  process.exit(1);
}

const billing = await loadBillingConfig(process.env);
if (billing.isErr()) {
  process.stderr.write(
    `${JSON.stringify({ level: "fatal", msg: "invalid billing configuration", issues: billing.error.issues })}\n`,
  );
  process.exit(1);
}
if (billing.value.mode === "cloud") {
  process.stderr.write(
    `${JSON.stringify({ level: "fatal", msg: "cloud billing is not yet available" })}\n`,
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
const store = createMailboxStore(database.value, authConfig.value.mailboxKey);
if (store.isErr()) {
  process.stderr.write(
    `${JSON.stringify({ level: "fatal", msg: "invalid mail configuration" })}\n`,
  );
  process.exit(1);
}
const mailboxStore = store.value;
const aliasStore = createAliasStore(database.value);
const aliases = createAliasService(
  aliasStore,
  createAliasMail(
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
  ),
  config.value.aliasPerUserCap,
);
const mail = createMailService({
  store: {
    getForOwner: async (userId, accountId) =>
      mailboxStore.getForOwner(userId, accountId),
  },
  origin: authConfig.value.stalwartOrigin,
  canSendAs: async (userId, address) => {
    const result = await aliases.canSendAs(userId, address);
    return result.isOk() ? result.value : null;
  },
  beforeAliasSend: createAliasSendGuard(aliases),
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
  identity: auth.identity,
  accounts: auth.accounts,
  ...(domains === undefined ? {} : { domains }),
  mail,
  calendar,
  aliases,
  ...(push === undefined ? {} : { push }),
  pushCleanup,
});
logPushFailure = (event) => app.log.warn(event, "push delivery failed");
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
