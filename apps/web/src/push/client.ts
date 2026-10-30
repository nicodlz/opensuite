import { contract, type PushProduct } from "@opensuite/contracts";
import { createORPCClient } from "@orpc/client";
import type { ContractRouterClient } from "@orpc/contract";
import { OpenAPILink } from "@orpc/openapi-client/fetch";
import { activeLayout } from "../origins.ts";
import {
  notificationEnabledEvent,
  notificationEnabledStorageKey,
} from "./hook.ts";

export const pushClient: ContractRouterClient<typeof contract> =
  createORPCClient(
    new OpenAPILink(contract, { url: `${window.location.origin}/api` }),
  );
/** Remove server records for this session across origins and this origin's browser endpoints before signing out. */
export async function clearPushOnSignOut() {
  if (!import.meta.env.DEV) await pushClient.push.clearSession({});
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) return;
  const registrations = await navigator.serviceWorker.getRegistrations();
  await Promise.all(
    registrations.map(async (registration) => {
      const script =
        registration.active?.scriptURL ??
        registration.waiting?.scriptURL ??
        registration.installing?.scriptURL;
      if (!script) return;
      const url = new URL(script);
      if (
        url.origin !== window.location.origin ||
        !/^\/push-sw-v\d+\.js$/.test(url.pathname)
      )
        return;
      const name = url.searchParams.get("product");
      if (name !== "mail" && name !== "calendar" && name !== "drive") return;
      const product: PushProduct = name;
      const subscription = await registration.pushManager.getSubscription();
      if (subscription) {
        if (!import.meta.env.DEV)
          await pushClient.push.unsubscribe({
            product,
            endpoint: subscription.endpoint,
          });
        if (!(await subscription.unsubscribe()))
          throw new Error("Could not disable notifications on this device.");
      }
    }),
  );
}

/** Feature entry points share the same browser subscription and API flow. */
export function supportsPush() {
  return (
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}
export function isIosUninstalled() {
  const ios =
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  return ios && !("standalone" in navigator && navigator.standalone === true);
}
export function pushScope(product: PushProduct) {
  return activeLayout().split ? "/" : `/${product}/`;
}
const calendarZone = (product: PushProduct) =>
  product === "calendar"
    ? { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }
    : {};
/** Refresh the zone for an existing subscription without creating a new one. */
export async function refreshCalendarTimeZone() {
  if (!supportsPush()) return;
  const registration = await navigator.serviceWorker.getRegistration(
    pushScope("calendar"),
  );
  const sub = await registration?.pushManager.getSubscription();
  if (sub)
    await pushClient.push.status({
      product: "calendar",
      endpoint: sub.endpoint,
      ...calendarZone("calendar"),
    });
}
export async function pushIsOn(product: PushProduct) {
  const reg =
    (await navigator.serviceWorker.getRegistration(pushScope(product))) ??
    (await navigator.serviceWorker.register(
      `/push-sw-v1.js?product=${product}`,
      { scope: pushScope(product), updateViaCache: "none" },
    ));
  const sub = await reg.pushManager.getSubscription();
  return (
    !!sub &&
    (
      await pushClient.push.status({
        product,
        endpoint: sub.endpoint,
        ...calendarZone(product),
      })
    ).subscribed
  );
}
function keyBytes(key: string): Uint8Array<ArrayBuffer> {
  const bytes = atob(
    key.replace(/-/g, "+").replace(/_/g, "/") +
      "=".repeat((4 - (key.length % 4)) % 4),
  );
  return Uint8Array.from(bytes, (character) => character.charCodeAt(0));
}
/** Call only from an explicit user action. */
export async function enablePush(
  product: PushProduct,
): Promise<NotificationPermission> {
  const permission = await Notification.requestPermission();
  if (permission !== "granted") return permission;
  const { publicKey } = await pushClient.push.publicKey({});
  const reg = await navigator.serviceWorker.register(
    `/push-sw-v1.js?product=${product}`,
    { scope: pushScope(product), updateViaCache: "none" },
  );
  let sub = await reg.pushManager.getSubscription();
  if (
    sub &&
    !(
      await pushClient.push.status({
        product,
        endpoint: sub.endpoint,
        ...calendarZone(product),
      })
    ).subscribed
  ) {
    await sub.unsubscribe();
    sub = null;
  }
  if (!sub)
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: keyBytes(publicKey),
    });
  const json = sub.toJSON();
  if (!json.keys?.["p256dh"] || !json.keys["auth"])
    throw new Error("Missing subscription keys");
  await pushClient.push.subscribe({
    product,
    endpoint: sub.endpoint,
    p256dh: json.keys["p256dh"],
    auth: json.keys["auth"],
    userAgent: navigator.userAgent.slice(0, 200),
    ...calendarZone(product),
  });
  // Close suggestions in this tab and other same-origin tabs once enabled.
  try {
    localStorage.setItem(
      notificationEnabledStorageKey,
      `${product}:${Date.now()}:${Math.random()}`,
    );
  } catch {
    /* The subscription works even when storage is unavailable. */
  }
  window.dispatchEvent(
    new CustomEvent(notificationEnabledEvent, { detail: product }),
  );
  return permission;
}
