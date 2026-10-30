import { JmapCapability, JmapClient } from "@opensuite/jmap";
import { StalwartAdmin } from "@opensuite/jmap/admin";
import type { AliasMail } from "@opensuite/core/services/aliases";
import type { MailCredentialStore } from "@opensuite/core/services/jmap-access";
import { err, ok } from "neverthrow";

export function createAliasMail(
  config: { origin: string; password: string; managementClientIp?: string },
  store: MailCredentialStore,
): AliasMail {
  const admin = new StalwartAdmin(
    config.origin,
    { username: "management@opensuite.internal", password: config.password },
    {
      fetch: (input, init) =>
        fetch(input, {
          ...init,
          headers: {
            ...Object.fromEntries(new Headers(init?.headers)),
            ...(config.managementClientIp
              ? { "X-Forwarded-For": config.managementClientIp }
              : {}),
          },
          signal: AbortSignal.timeout(10_000),
        }),
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
