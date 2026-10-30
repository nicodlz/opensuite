import * as React from "react";
import { useEffect, useState } from "react";
import type { PushProduct } from "@opensuite/contracts";
import {
  enablePush,
  isIosUninstalled,
  pushClient,
  pushIsOn,
  pushScope,
  supportsPush,
} from "./client.ts";
import { Button } from "../ui/button.tsx";
import { Dialog, DialogContent } from "../ui/dialog.tsx";

type Status = "unsupported" | "denied" | "off" | "on";
export function PushSettings({
  product,
  open,
  onOpenChange,
}: {
  product: PushProduct;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [status, setStatus] = useState<Status>("off");
  const [details, setDetails] = useState(false);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const iosUninstalled = isIosUninstalled();
  const supported = supportsPush();
  useEffect(() => {
    if (!open) return;
    void (async () => {
      await Promise.resolve();
      setMessage("");
      try {
        if (!supported) setStatus("unsupported");
        else if (Notification.permission === "denied") setStatus("denied");
        else {
          setStatus((await pushIsOn(product)) ? "on" : "off");
        }
        setDetails((await pushClient.push.privacy({})).showDetails);
      } catch {
        setMessage("Could not load notification settings.");
      }
    })();
  }, [open, product, supported]);
  async function perform(action: () => Promise<void>) {
    setBusy(true);
    setMessage("");
    try {
      await action();
    } catch {
      setMessage("Could not update notifications. Please try again.");
    } finally {
      setBusy(false);
    }
  }
  async function enable() {
    const permission = await enablePush(product);
    if (permission !== "granted") {
      setStatus(permission === "denied" ? "denied" : "off");
      return;
    }
    setStatus("on");
    setMessage("Notifications enabled on this device.");
  }
  async function disable() {
    const reg = await navigator.serviceWorker.getRegistration(
      pushScope(product),
    );
    const sub = await reg?.pushManager.getSubscription();
    if (sub) {
      await pushClient.push.unsubscribe({ product, endpoint: sub.endpoint });
      await sub.unsubscribe();
    }
    setStatus("off");
    setMessage("Notifications disabled on this device.");
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="Notifications"
        description={`Manage ${product} notifications on this device.`}
      >
        <p aria-live="polite">Status: {status}</p>
        {(iosUninstalled || !supported) && (
          <p>
            On iOS 16.4 or later, add this app to your Home Screen and open it
            there to enable Web Push. Use Share, then Add to Home Screen.
          </p>
        )}
        {status === "denied" && (
          <p>
            Notifications are blocked. Change permission in your browser or
            device settings.
          </p>
        )}
        <div className="dialog-actions">
          {status === "off" && (
            <Button
              disabled={busy || iosUninstalled}
              onClick={() => void perform(enable)}
            >
              Enable notifications
            </Button>
          )}
          {status === "on" && (
            <>
              <Button disabled={busy} onClick={() => void perform(disable)}>
                Disable notifications
              </Button>
              <Button
                disabled={busy}
                onClick={() =>
                  void perform(async () => {
                    await pushClient.push.test({ product });
                    setMessage("Test requested. Check your notifications.");
                  })
                }
              >
                Send test
              </Button>
            </>
          )}
        </div>
        <label>
          <input
            type="checkbox"
            checked={details}
            disabled={busy}
            onChange={(event) => {
              const value = event.target.checked;
              void perform(async () => {
                await pushClient.push.setPrivacy({ showDetails: value });
                setDetails(value);
              });
            }}
          />{" "}
          Show sender and subject in mail notifications
        </label>
        {!details && <p>Mail notifications show “New message”.</p>}
        <output>{message}</output>
      </DialogContent>
    </Dialog>
  );
}
