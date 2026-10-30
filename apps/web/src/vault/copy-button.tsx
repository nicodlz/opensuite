import * as React from "react";
import { useState } from "react";
import { Button } from "../ui/button.tsx";

let lastCopied: { value: string; id: number } | undefined;
let copyId = 0;
async function copy(value: string, clear: boolean) {
  await navigator.clipboard.writeText(value);
  const id = ++copyId;
  lastCopied = { value, id };
  if (clear)
    setTimeout(() => {
      if (lastCopied?.id !== id || lastCopied.value !== value) return;
      lastCopied = undefined;
      if (document.hasFocus())
        void navigator.clipboard.writeText("").catch(() => undefined);
    }, 30_000);
}
export function CopyButton({
  value,
  clear = false,
  label = "Copy",
}: {
  value: string;
  clear?: boolean;
  label?: string;
}) {
  const [message, setMessage] = useState("");
  return (
    <>
      <Button
        variant="secondary"
        onClick={() => {
          void copy(value, clear).then(
            () => setMessage("Copied"),
            () =>
              setMessage(
                "Could not copy. Select the text and copy it manually.",
              ),
          );
        }}
      >
        {label}
      </Button>
      <output className="vault-copy-message">{message}</output>
    </>
  );
}
