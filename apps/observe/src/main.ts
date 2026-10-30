import { createServer } from "node:http";
import { Config, inspect } from "./checks.ts";
import { createPublisher } from "./publisher.ts";
import { makeSources } from "./sources.ts";

const parsed = Config.safeParse(process.env);
if (!parsed.success) {
  process.stderr.write(
    `${JSON.stringify({ level: "fatal", event: "invalid_configuration", fields: parsed.error.issues.map((issue) => issue.path.join(".")) })}\n`,
  );
  process.exit(1);
}
const config = parsed.data;
const sources = makeSources(config);
let lastCompleted = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
const shutdown = new AbortController();
const server = createServer((request, response) => {
  const healthy =
    Date.now() - lastCompleted <
    (config.OBSERVE_INTERVAL_SECONDS * 2 + 60) * 1000;
  response.writeHead(request.url === "/health" && healthy ? 200 : 503).end();
});
server.listen(3003, "0.0.0.0");
const publish = createPublisher(
  config.OBSERVE_WEBHOOK_URL,
  config.OBSERVE_TIMEOUT_MS,
);
for (const name of ["SIGTERM", "SIGINT"])
  process.on(name, () => {
    shutdown.abort();
    if (timer !== undefined) clearTimeout(timer);
    server.close();
  });
const run = async (): Promise<void> => {
  const report = await inspect(config, sources, new Date());
  await publish(report);
  lastCompleted = Date.now();
  if (!shutdown.signal.aborted)
    timer = setTimeout(() => {
      void run();
    }, config.OBSERVE_INTERVAL_SECONDS * 1000);
};
await run();
