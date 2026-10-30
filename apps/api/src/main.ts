import { createReadinessService } from "@opensuite/core";
import {
  createDatabase,
  createDatabaseProbe,
  createMailboxStore,
} from "@opensuite/db";
import { createMailService } from "@opensuite/core/services/mail";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { loadApplicationDatabaseUrl, loadConfig } from "./config.ts";
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

const mailOrigin = process.env["JMAP_ORIGIN"];
const encryptionKey = process.env["PROVIDER_ENCRYPTION_KEY"];
let mail: ReturnType<typeof createMailService> | undefined;
if (mailOrigin !== undefined && encryptionKey !== undefined) {
  const store = createMailboxStore(database.value, encryptionKey);
  if (store.isErr() || !URL.canParse(mailOrigin)) {
    process.stderr.write(
      `${JSON.stringify({ level: "fatal", msg: "invalid mail configuration" })}\n`,
    );
    process.exit(1);
  }
  const mailboxStore = store.value;
  mail = createMailService({
    store: {
      getForOwner: async (userId, accountId) =>
        mailboxStore.getForOwner(userId, accountId),
    },
    origin: mailOrigin,
  });
}
const app = await buildServer({
  config: config.value,
  readiness,
  monotonicMs,
  ...(mail === undefined ? {} : { mail }),
});
app.addHook("onClose", async () => {
  await database.value.$disconnect();
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    app.log.info({ signal }, "shutting down");
    void app.close();
  });
}

await app.listen({ host: config.value.host, port: config.value.port });
