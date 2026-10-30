import * as React from "react";
import { useEffect, useState } from "react";
import {
  notificationOfferEvent,
  notificationEnabledEvent,
  notificationEnabledStorageKey,
  useNotificationPrompt,
  type NotificationOffer,
} from "./hook.ts";
import type { PushProduct } from "@opensuite/contracts";
import { Button } from "../ui/button.tsx";
import {
  enablePush,
  isIosUninstalled,
  pushIsOn,
  supportsPush,
} from "./client.ts";

const cooldownMs = 14 * 24 * 60 * 60_000;
const maxOffers = 3;
type Prompt = NotificationOffer & { kind: "enable" | "denied" | "install" };
type Memory = { count: number; nextAt: number };
function memoryKey(_product: PushProduct) {
  return "esuno-notification-offers";
}
function readMemory(product: PushProduct): Memory {
  try {
    const value: unknown = JSON.parse(
      localStorage.getItem(memoryKey(product)) ?? "null",
    );
    if (
      typeof value === "object" &&
      value !== null &&
      "count" in value &&
      "nextAt" in value &&
      typeof value.count === "number" &&
      typeof value.nextAt === "number" &&
      Number.isFinite(value.count) &&
      Number.isFinite(value.nextAt)
    )
      return { count: value.count, nextAt: value.nextAt };
  } catch {
    /* A damaged preference starts fresh. */
  }
  return { count: 0, nextAt: 0 };
}
function writeMemory(product: PushProduct, value: Memory) {
  localStorage.setItem(memoryKey(product), JSON.stringify(value));
}
export function NotificationPrompt({ product }: { product: PushProduct }) {
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    let checking = false;
    let revision = 0;
    const handle = (event: Event) => {
      if (!(event instanceof CustomEvent) || checking || prompt !== null)
        return;
      const data: unknown = event.detail;
      if (
        typeof data !== "object" ||
        data === null ||
        !("product" in data) ||
        data.product !== product ||
        !("message" in data) ||
        typeof data.message !== "string" ||
        !("reason" in data) ||
        typeof data.reason !== "string"
      )
        return;
      const details = { message: data.message, reason: data.reason };
      const attempt = revision;
      checking = true;
      void (async () => {
        try {
          const memory = readMemory(product);
          if (memory.count >= maxOffers || memory.nextAt > Date.now()) return;
          const install = isIosUninstalled();
          if (!install && !supportsPush()) return;
          const denied = !install && Notification.permission === "denied";
          if (
            !install &&
            !denied &&
            Notification.permission === "granted" &&
            (await pushIsOn(product))
          )
            return;
          if (!active || attempt !== revision) return;
          writeMemory(product, {
            count: memory.count + 1,
            nextAt: memory.nextAt,
          });
          setPrompt({
            ...details,
            kind: install ? "install" : denied ? "denied" : "enable",
          });
          setError("");
        } catch {
          /* Do not offer when eligibility cannot be checked. */
        } finally {
          checking = false;
        }
      })();
    };
    const enabled = (event: Event) => {
      if (event instanceof CustomEvent && event.detail === product) {
        revision++;
        setPrompt(null);
      }
    };
    const enabledElsewhere = (event: StorageEvent) => {
      if (
        event.key === notificationEnabledStorageKey &&
        event.newValue?.startsWith(`${product}:`)
      ) {
        revision++;
        setPrompt(null);
      }
    };
    window.addEventListener(notificationOfferEvent, handle);
    window.addEventListener(notificationEnabledEvent, enabled);
    window.addEventListener("storage", enabledElsewhere);
    return () => {
      active = false;
      window.removeEventListener(notificationOfferEvent, handle);
      window.removeEventListener(notificationEnabledEvent, enabled);
      window.removeEventListener("storage", enabledElsewhere);
    };
  }, [product, prompt]);
  if (!prompt) return null;
  function later() {
    try {
      const memory = readMemory(product);
      writeMemory(product, { ...memory, nextAt: Date.now() + cooldownMs });
    } catch {
      /* Dismiss even if storage is unavailable. */
    }
    setPrompt(null);
  }
  async function enable() {
    setBusy(true);
    setError("");
    try {
      const permission = await enablePush(product);
      if (permission === "granted") setPrompt(null);
      else if (permission === "denied")
        setPrompt((current) =>
          current ? { ...current, kind: "denied" } : null,
        );
    } catch {
      setError("Could not enable notifications. Please try again.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      className="notification-prompt"
      aria-label="Notification suggestion"
      aria-live="polite"
    >
      <div>
        <p>{prompt.message}</p>
        {prompt.kind === "denied" && (
          <p>
            Notifications are blocked. Allow them in your browser or device
            settings.
          </p>
        )}
        {prompt.kind === "install" && (
          <p>
            On iOS 16.4 or later, use Share → Add to Home Screen, then open the
            installed app to enable notifications.
          </p>
        )}
        {error && <p role="alert">{error}</p>}
      </div>
      <div className="notification-prompt-actions">
        {prompt.kind === "enable" && (
          <Button disabled={busy} onClick={() => void enable()}>
            Enable notifications
          </Button>
        )}
        <Button variant="secondary" disabled={busy} onClick={later}>
          Later
        </Button>
        <Button
          variant="ghost"
          disabled={busy}
          onClick={later}
          aria-label="Dismiss notification suggestion"
        >
          ×
        </Button>
      </div>
    </section>
  );
}
/** Mail offers on its first installed launch, or from the third browser session. */
export function MailNotificationOffer() {
  const { offer } = useNotificationPrompt("mail");
  useEffect(() => {
    try {
      if (sessionStorage.getItem("esuno-notification-mail-session")) return;
      sessionStorage.setItem("esuno-notification-mail-session", "1");
      const sessions =
        Number(
          localStorage.getItem("esuno-notification-mail-sessions") ?? "0",
        ) || 0;
      const next = sessions + 1;
      localStorage.setItem("esuno-notification-mail-sessions", String(next));
      const installed =
        window.matchMedia("(display-mode: standalone)").matches ||
        ("standalone" in navigator && navigator.standalone === true);
      const firstInstalled =
        installed && !localStorage.getItem("esuno-notification-mail-installed");
      if (installed)
        localStorage.setItem("esuno-notification-mail-installed", "1");
      if (installed || next >= 3)
        offer({
          reason: firstInstalled
            ? "installed"
            : installed
              ? "installed-return"
              : "third-session",
          message: "Get new mail notifications on this device.",
        });
    } catch {
      /* Storage may be unavailable. */
    }
  }, [offer]);
  return null;
}
