import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import type { ReactNode } from "react";
import { Button } from "./button.tsx";

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;

export function DialogContent({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="dialog-overlay" />
      <DialogPrimitive.Content className="dialog-content">
        <div className="dialog-heading">
          <div>
            <DialogPrimitive.Title className="dialog-title">
              {title}
            </DialogPrimitive.Title>
            <DialogPrimitive.Description className="dialog-description">
              {description}
            </DialogPrimitive.Description>
          </div>
          <DialogPrimitive.Close asChild>
            <Button variant="ghost" size="small" aria-label="Close dialog">
              ✕
            </Button>
          </DialogPrimitive.Close>
        </div>
        {children}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}
