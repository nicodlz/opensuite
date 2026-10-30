import process from "node:process";
import { createReadinessService } from "@opensuite/core";
import { buildServer } from "../apps/api/src/server.ts";

const monotonicMs = () => performance.now();
const app = await buildServer({
  config: { logLevel: "silent" },
  readiness: createReadinessService({
    probes: [],
    timeoutMs: 2000,
    now: () => new Date(),
    monotonicMs,
  }),
  monotonicMs,
});
const port = Number(process.env["E2E_API_PORT"] ?? 3199);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error("Invalid browser test port");
await app.listen({ host: "127.0.0.1", port });
