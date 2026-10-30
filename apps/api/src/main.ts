import { createReadinessService } from "@opensuite/core";
import { createDatabase, createDatabaseProbe } from "@opensuite/db";
import { performance } from "node:perf_hooks";
import process from "node:process";
import {
  loadApplicationDatabaseUrl,
  loadAuthConfig,
  loadConfig,
} from "./config.ts";
import { createAuthRuntime } from "./auth/runtime.ts";
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

const readiness = createReadinessService({
  probes: [createDatabaseProbe(database.value)],
  timeoutMs: config.value.readinessTimeoutMs,
  now: () => new Date(),
  monotonicMs,
});

const authConfig = await loadAuthConfig(process.env);
if (authConfig.isErr()) {
  process.stderr.write(
    `${JSON.stringify({ level: "fatal", msg: "invalid authentication configuration", issues: authConfig.error.issues })}\n`,
  );
  process.exit(1);
}
const auth = createAuthRuntime(database.value, authConfig.value);
const app = await buildServer({
  config: { ...config.value, trustProxy: authConfig.value.trustedProxyIp },
  readiness,
  monotonicMs,
  identity: auth.identity,
  accounts: auth.accounts,
});
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
