import { createReadinessService } from "@opensuite/core";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { loadConfig } from "./config.ts";
import { buildServer } from "./server.ts";

const config = loadConfig(process.env);
if (config.isErr()) {
  process.stderr.write(
    `${JSON.stringify({ level: "fatal", msg: "invalid configuration", issues: config.error.issues })}\n`,
  );
  process.exit(1);
}

const monotonicMs = () => performance.now();

// Declared dependencies: none yet. Each backing service (database, mail
// server) registers its probe here as it is wired in.
const readiness = createReadinessService({
  probes: [],
  timeoutMs: config.value.readinessTimeoutMs,
  now: () => new Date(),
  monotonicMs,
});

const app = await buildServer({ config: config.value, readiness, monotonicMs });

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    app.log.info({ signal }, "shutting down");
    void app.close();
  });
}

await app.listen({ host: config.value.host, port: config.value.port });
