import { readFile } from "node:fs/promises";
import { z } from "zod";
import { StalwartAdmin } from "@opensuite/jmap/admin";
import { createSesDomainProvider } from "@opensuite/core/adapters/domain-ses";
import { nodeDomainDns } from "@opensuite/core/adapters/domain-dns";
import {
  createDomainService,
  type DomainMail,
} from "@opensuite/core/services/domains";
import type { createDomainStore } from "@opensuite/db";

const failure = (): { kind: "unavailable"; message: string } => ({
  kind: "unavailable",
  message: "Stalwart management operation failed",
});

/** Configuration is opt-in. Merely starting the API never contacts SES. */
export async function configureDomains(
  env: NodeJS.ProcessEnv,
  store: ReturnType<typeof createDomainStore>,
) {
  if (env["DOMAINS_SES_ENABLED"] !== "true") return undefined;
  const config = z
    .object({
      DOMAINS_SES_RULE: z.string().min(1),
      DOMAINS_STALWART_ORIGIN: z.url(),
      DOMAINS_STALWART_USER: z.string().min(1),
      DOMAINS_STALWART_PASSWORD_FILE: z.string().min(1),
      DOMAINS_SES_ENDPOINT: z.url().optional(),
    })
    .parse(env);
  const password = (
    await readFile(config.DOMAINS_STALWART_PASSWORD_FILE, "utf8")
  ).trim();
  if (!password) throw new Error("empty Stalwart administrator password");
  const admin = new StalwartAdmin(config.DOMAINS_STALWART_ORIGIN, {
    username: config.DOMAINS_STALWART_USER,
    password,
  });
  const mail: DomainMail = {
    async createDomain(name) {
      return (await admin.createDomain(name)).mapErr(failure);
    },
    async dkimRecords(id) {
      return (await admin.dkimRecords(id)).mapErr(failure);
    },
    async createAlias(accountId, name, domainId) {
      return (await admin.createAlias(accountId, name, domainId)).mapErr(
        failure,
      );
    },
    async removeAlias(accountId, name, domainId) {
      return (await admin.removeAlias(accountId, name, domainId)).mapErr(
        failure,
      );
    },
  };
  const provider = createSesDomainProvider({
    enabled: true,
    ruleName: config.DOMAINS_SES_RULE,
    ...(config.DOMAINS_SES_ENDPOINT === undefined
      ? {}
      : { endpoint: config.DOMAINS_SES_ENDPOINT }),
  });
  if (provider === undefined) throw new Error("SES provider disabled");
  return createDomainService(store, provider, mail, nodeDomainDns);
}
