import {
  CloudWatchClient,
  GetMetricStatisticsCommand,
} from "@aws-sdk/client-cloudwatch";
import { GetQueueAttributesCommand, SQSClient } from "@aws-sdk/client-sqs";
import { readFile, stat, statfs } from "node:fs/promises";
import { connect } from "node:tls";
import type { Config, QueueStats, Sources } from "./checks.ts";

export const makeSources = (config: Config): Sources => {
  const options = {
    region: config.AWS_REGION,
    ...(config.AWS_ENDPOINT_URL === undefined
      ? {}
      : { endpoint: config.AWS_ENDPOINT_URL }),
  };
  const sqs = new SQSClient(options);
  const cloudwatch = new CloudWatchClient(options);
  const signal = () => AbortSignal.timeout(config.OBSERVE_TIMEOUT_MS);
  return {
    async ready(service) {
      const ports: Record<string, number> = {
        api: 3000,
        drive: 3001,
        ingest: 3002,
      };
      const response = await fetch(
        `http://${service}:${String(ports[service])}/ready`,
        { signal: signal(), redirect: "error" },
      );
      return response.ok;
    },
    async backupAge() {
      return (Date.now() - (await stat("/backup/last-success")).mtimeMs) / 1000;
    },
    async backupFailure() {
      try {
        const failure = (await readFile("/backup/last-failure", "utf8")).trim();
        return failure === "vault" ? "vault" : "backup";
      } catch (error) {
        if (
          error instanceof Error &&
          "code" in error &&
          error.code === "ENOENT"
        )
          return null;
        throw error;
      }
    },
    async diskPercent() {
      const disk = await statfs("/host-disk");
      return 100 * (1 - disk.bavail / disk.blocks);
    },
    async setupOk() {
      return (await readFile("/setup-status/status", "utf8")).trim() === "ok";
    },
    async certificateDays(service) {
      return new Promise<number>((resolve, reject) => {
        const socket = connect({
          host:
            service === "https"
              ? config.OBSERVE_CERT_CONNECT_HOST
              : config.OBSERVE_MAIL_CERT_CONNECT_HOST,
          port:
            service === "https" ? 443 : service === "submission" ? 465 : 993,
          servername:
            service === "https"
              ? config.OBSERVE_CERT_HOST
              : config.OBSERVE_MAIL_CERT_HOST,
          rejectUnauthorized: false,
        });
        socket.setTimeout(config.OBSERVE_TIMEOUT_MS, () =>
          socket.destroy(new Error("timeout")),
        );
        socket.once("error", reject);
        socket.once("secureConnect", () => {
          const certificate = socket.getPeerCertificate();
          socket.destroy();
          const expiry = Date.parse(certificate.valid_to);
          if (!Number.isFinite(expiry))
            reject(new Error("missing certificate"));
          else resolve((expiry - Date.now()) / 86400000);
        });
      });
    },
    async queue(url): Promise<QueueStats> {
      const response = await sqs.send(
        new GetQueueAttributesCommand({
          QueueUrl: url,
          AttributeNames: [
            "ApproximateNumberOfMessages",
            "ApproximateNumberOfMessagesNotVisible",
            "ApproximateNumberOfMessagesDelayed",
          ],
        }),
        { abortSignal: signal() },
      );
      const attributes = response.Attributes;
      const number = (
        name:
          | "ApproximateNumberOfMessages"
          | "ApproximateNumberOfMessagesNotVisible"
          | "ApproximateNumberOfMessagesDelayed",
      ) => {
        const value = attributes?.[name];
        if (value === undefined || !/^\d+$/.test(value))
          throw new Error("missing queue attribute");
        return Number(value);
      };
      const end = new Date();
      const queueName = new URL(url).pathname
        .split("/")
        .findLast((part) => part.length > 0);
      if (queueName === undefined) throw new Error("missing queue name");
      let oldestSeconds: number | null = null;
      let ageAvailable = false;
      try {
        const ages = await cloudwatch.send(
          new GetMetricStatisticsCommand({
            Namespace: "AWS/SQS",
            MetricName: "ApproximateAgeOfOldestMessage",
            Dimensions: [{ Name: "QueueName", Value: queueName }],
            StartTime: new Date(end.getTime() - 15 * 60_000),
            EndTime: end,
            Period: 300,
            Statistics: ["Maximum"],
          }),
          { abortSignal: signal() },
        );
        const points = (ages.Datapoints ?? [])
          .filter(
            (point) =>
              point.Timestamp !== undefined && point.Maximum !== undefined,
          )
          .toSorted(
            (a, b) =>
              (b.Timestamp?.getTime() ?? 0) - (a.Timestamp?.getTime() ?? 0),
          );
        oldestSeconds = points[0]?.Maximum ?? null;
        ageAvailable = true;
      } catch {
        // Preserve SQS depth even if CloudWatch is unavailable.
      }
      return {
        visible: number("ApproximateNumberOfMessages"),
        inFlight: number("ApproximateNumberOfMessagesNotVisible"),
        delayed: number("ApproximateNumberOfMessagesDelayed"),
        oldestSeconds,
        ageAvailable,
      };
    },
  };
};
