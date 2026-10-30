import { createReadinessService, httpProbe } from "@opensuite/core";
import {
  createDatabase,
  createDatabaseProbe,
  createDomainStore,
} from "@opensuite/db";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { loadApplicationDatabaseUrl, loadConfig } from "./config.ts";
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

const readiness = createReadinessService({
  probes: [
    createDatabaseProbe(database.value),
    httpProbe("mail-server", config.value.stalwartReadyUrl),
  ],
  timeoutMs: config.value.readinessTimeoutMs,
  now: () => new Date(),
  monotonicMs,
});

const domainStore = createDomainStore(database.value);
const domains = await configureDomains(process.env, domainStore);
const app = await buildServer({
  config: config.value,
  readiness,
  monotonicMs,
  ...(domains === undefined ? {} : { domains }),
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
app.addHook("onClose", async () => {
  await stopDomainJob?.();
  await database.value.$disconnect();
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    app.log.info({ signal }, "shutting down");
    void app.close();
  });
}

await app.listen({ host: config.value.host, port: config.value.port });
