import { resolveCname, resolveMx, resolveTxt } from "node:dns/promises";
import { ResultAsync } from "neverthrow";
import type { DnsPort } from "../services/domains.ts";
const canonical = (value: string) => value.replace(/\.$/, "").toLowerCase();
export const nodeDomainDns: DnsPort = {
  async lookup(record) {
    const result = await ResultAsync.fromPromise(
      (async () => {
        if (record.type === "MX")
          return (await resolveMx(record.name)).some(
            (item) =>
              canonical(item.exchange) === canonical(record.value) &&
              item.priority === record.priority,
          );
        if (record.type === "CNAME")
          return (await resolveCname(record.name)).some(
            (item) => canonical(item) === canonical(record.value),
          );
        const values = (await resolveTxt(record.name)).map((parts) =>
          parts.join(""),
        );
        if (record.value.startsWith("v=spf1")) {
          const policies = values.filter((value) => /^v=spf1\b/i.test(value));
          return (
            policies.length === 1 &&
            policies.some((value) =>
              /(?:^|\s)include:amazonses\.com(?:\s|$)/i.test(value),
            )
          );
        }
        if (record.value.startsWith("v=DMARC1")) {
          const policies = values.filter((value) =>
            /^v=DMARC1\s*;/i.test(value),
          );
          return (
            policies.length === 1 &&
            policies.some((value) =>
              /(?:^|;)\s*p=(none|quarantine|reject)(?:\s*;|\s*$)/i.test(value),
            )
          );
        }
        return values.some((value) => value === record.value);
      })(),
      (): { kind: "unavailable"; message: string } => ({
        kind: "unavailable",
        message: "DNS lookup failed",
      }),
    );
    return result;
  },
};
