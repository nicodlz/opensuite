import webPush from "web-push";
import type { Agent } from "node:https";
import type { PushTransport } from "../services/notifications.ts";

export function createWebPushTransport(
  publicKey: string,
  privateKey: string,
  subject: string,
  agent?: Agent,
): PushTransport {
  return {
    async send(subscription, payload, options) {
      await webPush.sendNotification(
        {
          endpoint: subscription.endpoint,
          keys: { p256dh: subscription.p256dh, auth: subscription.auth },
        },
        payload,
        {
          vapidDetails: { subject, publicKey, privateKey },
          TTL: options?.ttl ?? 300,
          timeout: 10_000,
          urgency: options?.urgency ?? "normal",
          ...(agent === undefined ? {} : { agent }),
        },
      );
    },
  };
}
