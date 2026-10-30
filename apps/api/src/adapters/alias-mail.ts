import { timedFetch } from "./timed-fetch.ts";
import { JmapCapability, JmapClient } from "@opensuite/jmap";
import { StalwartAdmin } from "@opensuite/jmap/admin";
import type { AliasMail, AliasService } from "@opensuite/core/services/aliases";
import type { MailCredentialStore } from "@opensuite/core/services/jmap-access";
import { err, ok } from "neverthrow";
import { createAliasLimiter } from "../auth/alias-limits.ts";

export function createAliasSendGuard(service: AliasService) {
  const limits = createAliasLimiter();
  return async (userId: string, aliasId: string) => {
    if (!limits.send(userId)) return false;
    const audited = await service.auditSubmission(userId, aliasId);
    if (audited.isErr()) throw new Error("alias audit unavailable");
    return true;
  };
}

export function createAliasMail(
  config: {
    origin: string;
    password: string;
    managementClientIp?: string;
    username?: string;
  },
  store: MailCredentialStore,
): AliasMail {
  const admin = new StalwartAdmin(
    config.origin,
    {
      username: config.username ?? "management@opensuite.internal",
      password: config.password,
    },
    {
      fetch: timedFetch(
        config.managementClientIp
          ? { "X-Forwarded-For": config.managementClientIp }
          : {},
      ),
    },
  );
  return {
    async set(accountId, localPart, domainId, address, userId, enabled) {
      const result = enabled
        ? await admin.createAlias(accountId, localPart, domainId)
        : await admin.removeAlias(accountId, localPart, domainId);
      if (result.isErr()) return err({ kind: "unavailable" });
      const credential = await store.getForOwner(userId, accountId);
      if (credential.isErr())
        return enabled ? err({ kind: "unavailable" }) : ok(undefined);
      const client = new JmapClient(config.origin, {
        authorization: `Basic ${Buffer.from(`${credential.value.address}:${credential.value.secret}`).toString("base64")}`,
        rewriteSessionUrlsToOrigin: config.origin,
        timeoutMs: 10_000,
      });
      const session = await client.discover();
      if (session.isErr()) return err({ kind: "unavailable" });
      const id = session.value.primaryAccounts[JmapCapability.mail];
      if (!id) return err({ kind: "unavailable" });
      const identities = await client.identities(session.value, id);
      if (identities.isErr()) return err({ kind: "unavailable" });
      const exists = identities.value.list.some(
        (item) => item.email.toLowerCase() === address.toLowerCase(),
      );
      return exists === enabled ? ok(undefined) : err({ kind: "unavailable" });
    },
  };
}
