import { z } from "zod";

export const Config = z.object({
  OBSERVE_INTERVAL_SECONDS: z.coerce
    .number()
    .int()
    .min(30)
    .max(3600)
    .default(300),
  OBSERVE_TIMEOUT_MS: z.coerce.number().int().min(500).max(30000).default(5000),
  OBSERVE_BACKUP_MAX_AGE_SECONDS: z.coerce.number().positive().default(93600),
  OBSERVE_DISK_PERCENT: z.coerce.number().min(1).max(100).default(85),
  OBSERVE_CERT_DAYS: z.coerce.number().positive().default(21),
  OBSERVE_QUEUE_MAX_AGE_SECONDS: z.coerce.number().positive().default(3600),
  OBSERVE_DLQ_MAX_AGE_SECONDS: z.coerce.number().positive().default(300),
  OBSERVE_INGEST_ENABLED: z.enum(["true", "false"]).default("false"),
  OBSERVE_QUEUE_URL: z.url().optional(),
  OBSERVE_DLQ_URL: z.url().optional(),
  OBSERVE_WEBHOOK_URL: z.url().optional(),
  OBSERVE_CERT_HOST: z.string().min(1).default("localhost"),
  OBSERVE_CERT_CONNECT_HOST: z.string().min(1).default("caddy"),
  OBSERVE_MAIL_CERT_HOST: z.string().min(1).default("localhost"),
  OBSERVE_MAIL_CERT_CONNECT_HOST: z.string().min(1).default("stalwart"),
  OBSERVE_MAIL_TLS_ENABLED: z.enum(["0", "1"]).default("0"),
  AWS_REGION: z.string().min(1).default("eu-north-1"),
  AWS_ENDPOINT_URL: z.url().optional(),
});
export type Config = z.infer<typeof Config>;
export interface QueueStats {
  visible: number;
  inFlight: number;
  delayed: number;
  oldestSeconds: number | null;
  ageAvailable: boolean;
}
export interface Sources {
  ready(service: string): Promise<boolean>;
  backupAge(): Promise<number>;
  diskPercent(): Promise<number>;
  certificateDays(service: "https" | "submission" | "imaps"): Promise<number>;
  setupOk(): Promise<boolean>;
  queue(url: string): Promise<QueueStats>;
}
interface Alert {
  code: string;
  value?: number;
}
export interface Report {
  checkedAt: string;
  metrics: Record<string, number>;
  alerts: Alert[];
}

export async function inspect(
  config: Config,
  sources: Sources,
  now: Date,
): Promise<Report> {
  const metrics: Record<string, number> = {};
  const alerts: Alert[] = [];
  const check = async (
    code: string,
    read: () => Promise<number>,
    bad: (value: number) => boolean,
  ) => {
    try {
      const value = await read();
      if (!Number.isFinite(value)) throw new Error("invalid measurement");
      metrics[code] = value;
      if (bad(value)) alerts.push({ code, value });
    } catch {
      alerts.push({ code: `${code}_unavailable` });
    }
  };
  const services = [
    "api",
    "drive",
    ...(config.OBSERVE_INGEST_ENABLED === "true" ? ["ingest"] : []),
  ];
  await Promise.all([
    ...services.map((name) =>
      check(
        `${name}_readiness`,
        async () => Number(await sources.ready(name)),
        (value) => value !== 1,
      ),
    ),
    check(
      "backup_age_seconds",
      () => sources.backupAge(),
      (value) => value < 0 || value > config.OBSERVE_BACKUP_MAX_AGE_SECONDS,
    ),
    check(
      "disk_used_percent",
      () => sources.diskPercent(),
      (value) => value >= config.OBSERVE_DISK_PERCENT,
    ),
    check(
      "certificate_days",
      () => sources.certificateDays("https"),
      (value) => value <= config.OBSERVE_CERT_DAYS,
    ),
    check(
      "stalwart_setup",
      async () => Number(await sources.setupOk()),
      (value) => value !== 1,
    ),
    ...(config.OBSERVE_MAIL_TLS_ENABLED === "1"
      ? (["submission", "imaps"] as const).map((service) =>
          check(
            `mail_${service}_certificate_days`,
            () => sources.certificateDays(service),
            (value) => value <= config.OBSERVE_CERT_DAYS,
          ),
        )
      : []),
    ...(config.OBSERVE_INGEST_ENABLED === "true"
      ? (
          [
            [
              "queue",
              config.OBSERVE_QUEUE_URL,
              config.OBSERVE_QUEUE_MAX_AGE_SECONDS,
            ],
            ["dlq", config.OBSERVE_DLQ_URL, config.OBSERVE_DLQ_MAX_AGE_SECONDS],
          ] satisfies [string, string | undefined, number][]
        ).map(async ([kind, url, limit]) => {
          if (url === undefined) {
            alerts.push({ code: `${kind}_configuration` });
            return;
          }
          try {
            const stats = await sources.queue(url);
            const depth = stats.visible + stats.inFlight + stats.delayed;
            if (
              ![depth, stats.visible, stats.inFlight, stats.delayed].every(
                (v) => Number.isFinite(v) && v >= 0,
              )
            )
              throw new Error("invalid queue measurement");
            metrics[`${kind}_depth`] = depth;
            if (kind === "dlq" && depth > 0)
              alerts.push({ code: "dlq_messages", value: depth });
            if (!stats.ageAvailable) {
              alerts.push({ code: `${kind}_age_unavailable` });
            } else if (
              stats.oldestSeconds !== null &&
              Number.isFinite(stats.oldestSeconds) &&
              stats.oldestSeconds >= 0
            ) {
              metrics[`${kind}_age_seconds`] = stats.oldestSeconds;
              if (depth > 0 && stats.oldestSeconds >= limit)
                alerts.push({
                  code: `${kind}_age_seconds`,
                  value: stats.oldestSeconds,
                });
            } else if (depth > 0)
              alerts.push({ code: `${kind}_age_unavailable` });
          } catch {
            alerts.push({ code: `${kind}_unavailable` });
          }
        })
      : []),
  ]);
  return {
    checkedAt: now.toISOString(),
    metrics,
    alerts: alerts.toSorted((a, b) => a.code.localeCompare(b.code)),
  };
}
