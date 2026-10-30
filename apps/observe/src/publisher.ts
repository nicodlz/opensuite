import type { Report } from "./checks.ts";

export function createPublisher(
  url: string | undefined,
  timeoutMs: number,
  send: typeof fetch = fetch,
  log: (entry: Record<string, unknown>) => void = (entry) => {
    process.stdout.write(`${JSON.stringify(entry)}\n`);
  },
) {
  let previous = new Set<string>();
  return async (report: Report): Promise<void> => {
    const current = new Set(report.alerts.map((alert) => alert.code));
    const recovered = [...previous].filter((code) => !current.has(code));
    log({
      level: report.alerts.length ? "warn" : "info",
      event: "observation",
      ...report,
      recovered,
    });
    if (url === undefined) {
      log({ level: "error", event: "webhook_not_configured" });
      return;
    }
    if (report.alerts.length === 0 && recovered.length === 0) return;
    try {
      const response = await send(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...report, recovered }),
        signal: AbortSignal.timeout(timeoutMs),
        redirect: "error",
      });
      if (!response.ok) throw new Error("delivery failed");
      previous = current;
    } catch {
      log({ level: "error", event: "webhook_delivery_failed" });
    }
  };
}
