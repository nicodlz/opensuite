import type { PrismaClient } from "@opensuite/db";
import { createPushStore } from "@opensuite/db";
import { createNotificationDispatcher } from "@opensuite/core/services/notifications";
import { createWebPushTransport } from "@opensuite/core/adapters/web-push";
import { loadVapidConfig } from "./config.ts";
import type { PushProduct } from "@opensuite/contracts";

/** Missing VAPID disables only push; no secret values enter diagnostics. */
export async function configurePush(
  env: Readonly<Record<string, string | undefined>>,
  db: PrismaClient,
  subject: string,
  warn: () => void,
  logFailure: (event: { product: PushProduct; status: number | null }) => void,
) {
  const vapid = await loadVapidConfig(env);
  if (vapid.isErr()) {
    warn();
    return undefined;
  }
  const store = createPushStore(db, vapid.value.publicKey);
  return {
    publicKey: vapid.value.publicKey,
    store,
    dispatcher: createNotificationDispatcher(
      store,
      createWebPushTransport(
        vapid.value.publicKey,
        vapid.value.privateKey,
        subject,
      ),
      () => new Date(),
      logFailure,
    ),
  };
}
