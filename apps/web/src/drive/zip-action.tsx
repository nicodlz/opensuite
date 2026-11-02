import * as React from "react";
import { useState } from "react";
import { Button } from "../ui/button.tsx";
import { Icon } from "../ui/icons.tsx";
import { useToast } from "../ui/toast.tsx";
import { command, driveTransport } from "./client.ts";
import type { DriveEntry } from "./model.ts";

function startDownload(url: string, name: string) {
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.rel = "noopener";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  if (url.startsWith("blob:"))
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
export async function download(
  entry: DriveEntry,
  notice: (text: string) => void,
) {
  try {
    const result = await command({ action: "download", id: entry.id });
    if (!("url" in result) || !result.url)
      throw new Error("Missing download URL");
    startDownload(result.url, entry.name);
  } catch {
    notice("Could not download this file. Please try again.");
  }
}
export function ZipAction({
  items,
  folderOnly = false,
}: {
  items: DriveEntry[];
  folderOnly?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const { notify } = useToast();
  const label = busy ? "Preparing ZIP…" : "Download as ZIP";
  async function downloadZip() {
    setBusy(true);
    try {
      const url = await driveTransport.zip(items.map((item) => item.id));
      startDownload(url, "Drive.zip");
      notify({ message: "ZIP download started." });
    } catch (error) {
      notify({
        message:
          error instanceof Error
            ? error.message
            : "Could not prepare ZIP download.",
      });
    } finally {
      setBusy(false);
    }
  }
  if (folderOnly && items[0]?.kind !== "folder") return null;
  return (
    <Button
      variant="secondary"
      size="small"
      title={label}
      disabled={busy || items.some((entry) => entry.state !== "ready")}
      onClick={() => {
        void downloadZip();
      }}
    >
      <Icon name="download" size={16} />
      <span className="drive-action-label">{label}</span>
    </Button>
  );
}
