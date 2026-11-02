import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { useState } from "react";
import { Button } from "../ui/button.tsx";
import { Dialog, DialogContent } from "../ui/dialog.tsx";

/**
 * A consequential action behind a confirmation dialog. With `acknowledge`,
 * the user must tick a statement before the action is possible.
 */
export function ConfirmAction({
  label,
  title,
  description,
  confirmLabel,
  acknowledge,
  disabled,
  onConfirm,
}: {
  label: string;
  title: string;
  description: string;
  confirmLabel: string;
  acknowledge?: string;
  disabled?: boolean;
  onConfirm: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [checked, setChecked] = useState(false);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        setChecked(false);
      }}
    >
      {/* A trigger lets the dialog return focus to it when it closes. */}
      <DialogPrimitive.Trigger asChild>
        <Button type="button" variant="secondary" disabled={disabled}>
          {label}
        </Button>
      </DialogPrimitive.Trigger>
      <DialogContent title={title} description={description}>
        {acknowledge && (
          <label className="migration-filter">
            <input
              type="checkbox"
              checked={checked}
              onChange={(event) => setChecked(event.target.checked)}
            />
            {acknowledge}
          </label>
        )}
        <div className="dialog-actions migration-actions">
          <Button
            type="button"
            variant="secondary"
            onClick={() => setOpen(false)}
          >
            Keep it
          </Button>
          <Button
            type="button"
            disabled={acknowledge !== undefined && !checked}
            onClick={() => {
              setOpen(false);
              onConfirm();
            }}
          >
            {confirmLabel}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
