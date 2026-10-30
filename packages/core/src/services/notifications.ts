import type { PushProduct } from "@opensuite/contracts";

export interface NotificationPayload {
  title: string;
  body?: string;
  url: string;
  tag: string;
  icon?: string;
}
export interface NotificationOptions {
  ttl?: number;
  urgency?: "very-low" | "low" | "normal" | "high";
}
export interface NotificationResult {
  outcome:
    "delivered" | "failed" | "no_subscriptions" | "duplicate" | "invalid";
  delivered: number;
  failed: number;
  /** Present only for invalid inputs. */
  reason?: string;
}
/** Existing three-argument calls remain valid. Tags deduplicate per user and product for five minutes. */
export interface NotificationDispatcher {
  notify(
    userId: string,
    product: PushProduct,
    payload: NotificationPayload,
    options?: NotificationOptions,
  ): Promise<void>;
}
export interface DetailedNotificationDispatcher extends NotificationDispatcher {
  notifyWithResult(
    userId: string,
    product: PushProduct,
    payload: NotificationPayload,
    options?: NotificationOptions,
  ): Promise<NotificationResult>;
}
export interface PushSubscriptionRecord {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  failureCount: number;
}
export interface NotificationStore {
  claim(
    userId: string,
    product: PushProduct,
    tag: string,
    now: Date,
    expires: Date,
  ): Promise<boolean>;
  release(
    userId: string,
    product: PushProduct,
    tag: string,
    expires: Date,
  ): Promise<void>;
  showDetails(userId: string): Promise<boolean>;
  eligible(
    userId: string,
    product: PushProduct,
    now: Date,
  ): Promise<PushSubscriptionRecord[]>;
  success(id: string, now: Date): Promise<void>;
  purge(id: string): Promise<void>;
  failure(id: string, now: Date, next: Date): Promise<void>;
}
export interface PushTransport {
  send(
    subscription: PushSubscriptionRecord,
    payload: string,
    options?: NotificationOptions,
  ): Promise<void>;
}
const validPath = (path: string) =>
  path.startsWith("/") &&
  !path.startsWith("//") &&
  !path.includes("\\") &&
  !Array.from(path).some((character) => character.charCodeAt(0) < 32);
export function createNotificationDispatcher(
  store: NotificationStore,
  transport: PushTransport,
  now: () => Date = () => new Date(),
  logFailure: (event: {
    product: PushProduct;
    status: number | null;
  }) => void = () => {},
): DetailedNotificationDispatcher {
  const notifyWithResult: DetailedNotificationDispatcher["notifyWithResult"] =
    async (userId, product, payload, options = {}) => {
      if (
        !payload.title ||
        !payload.tag ||
        payload.tag.length > 200 ||
        !validPath(payload.url) ||
        (payload.icon !== undefined &&
          (!validPath(payload.icon) || !payload.icon.startsWith("/icons/"))) ||
        (options.ttl !== undefined &&
          (!Number.isInteger(options.ttl) ||
            options.ttl < 0 ||
            options.ttl > 2_419_200)) ||
        (options.urgency !== undefined &&
          !["very-low", "low", "normal", "high"].includes(options.urgency))
      )
        return {
          outcome: "invalid",
          delivered: 0,
          failed: 0,
          reason: "Invalid notification payload or options",
        };
      const details = product !== "mail" || (await store.showDetails(userId));
      const visible: NotificationPayload = details
        ? payload
        : {
            title: "New message",
            url: payload.url,
            tag: payload.tag,
            ...(payload.icon === undefined ? {} : { icon: payload.icon }),
          };
      const encoded = JSON.stringify(visible);
      if (Buffer.byteLength(encoded, "utf8") > 3000)
        return {
          outcome: "invalid",
          delivered: 0,
          failed: 0,
          reason: "Notification payload too large",
        };
      const current = now();
      const expires = new Date(current.getTime() + 300_000);
      if (!(await store.claim(userId, product, payload.tag, current, expires)))
        return { outcome: "duplicate", delivered: 0, failed: 0 };
      let delivered = 0;
      let failed = 0;
      try {
        const subscriptions = await store.eligible(userId, product, current);
        const outcomes = await Promise.allSettled(
          subscriptions.map(async (subscription) => {
            try {
              if (options.ttl === undefined && options.urgency === undefined)
                await transport.send(subscription, encoded);
              else await transport.send(subscription, encoded, options);
            } catch (error) {
              const raw =
                typeof error === "object" &&
                error !== null &&
                "statusCode" in error
                  ? error.statusCode
                  : undefined;
              const status =
                typeof raw === "number" &&
                Number.isInteger(raw) &&
                raw >= 100 &&
                raw <= 599
                  ? raw
                  : null;
              failed++;
              logFailure({ product, status });
              if (
                status === 401 ||
                status === 403 ||
                status === 404 ||
                status === 410
              )
                await store.purge(subscription.id);
              else {
                const delay = Math.min(
                  24 * 60 * 60_000,
                  60_000 * 2 ** Math.min(subscription.failureCount, 10),
                );
                await store.failure(
                  subscription.id,
                  current,
                  new Date(current.getTime() + delay),
                );
              }
              return;
            }
            delivered++;
            await store.success(subscription.id, current);
          }),
        );
        if (outcomes.some((outcome) => outcome.status === "rejected"))
          throw new Error("Notification bookkeeping failed");
        return {
          outcome:
            delivered > 0
              ? "delivered"
              : failed > 0
                ? "failed"
                : "no_subscriptions",
          delivered,
          failed,
        };
      } finally {
        if (delivered === 0)
          await store.release(userId, product, payload.tag, expires);
      }
    };
  return {
    async notify(userId, product, payload, options) {
      const result = await notifyWithResult(userId, product, payload, options);
      if (result.outcome === "invalid") throw new Error(result.reason);
    },
    notifyWithResult,
  };
}
