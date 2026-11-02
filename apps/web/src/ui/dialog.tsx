import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import type { ReactNode } from "react";
import { Button } from "./button.tsx";

export const Dialog = DialogPrimitive.Root;

const fieldSelector =
  "input:not([type='hidden']):not(:disabled), select:not(:disabled), textarea:not(:disabled)";

/**
 * Where focus lands when a dialog opens: an element marked `data-autofocus`,
 * else the first visible form field. Null leaves focus on the dialog itself,
 * so the close button is never the first stop and Enter in a field submits
 * the dialog's form.
 */
export function initialFocus(content: HTMLElement): HTMLElement | null {
  const marked = content.querySelector<HTMLElement>("[data-autofocus]");
  if (marked) return marked;
  for (const element of content.querySelectorAll<HTMLElement>("*"))
    if (element.matches(fieldSelector) && element.checkVisibility())
      return element;
  return null;
}

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
      <DialogPrimitive.Content
        className="dialog-content"
        onOpenAutoFocus={(event) => {
          if (!(event.currentTarget instanceof HTMLElement)) return;
          event.preventDefault();
          (initialFocus(event.currentTarget) ?? event.currentTarget).focus();
        }}
      >
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
