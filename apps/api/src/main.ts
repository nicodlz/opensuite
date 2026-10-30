import { createReadinessService, httpProbe } from "@opensuite/core";
import {
  createDatabase,
  createDatabaseProbe,
  createDomainStore,
  createMailboxStore,
} from "@opensuite/db";
import { createMailService } from "@opensuite/core/services/mail";
import { performance } from "node:perf_hooks";
import process from "node:process";
import {
  loadApplicationDatabaseUrl,
  loadAuthConfig,
  loadConfig,
} from "./config.ts";
import { createAuthRuntime } from "./auth/runtime.ts";
import { startDomainJob } from "./routes/domain-job.ts";
import { configureDomains } from "./routes/domain-setup.ts";
import { buildServer } from "./server.ts";

const config = loadConfig(process.env);
if (config.isErr()) {
  process.stderr.write(
    `${JSON.stringify({ level: "fatal", msg: "invalid configuration", issues: config.error.issues })}\n`,
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
const mail = createMailService({
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
  identity: auth.identity,
  accounts: auth.accounts,
  ...(domains === undefined ? {} : { domains }),
  mail,
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
let running: Promise<void> | undefined;
const work = async () => {
  try {
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
