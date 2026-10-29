import * as React from "react";
import * as ToastPrimitive from "@radix-ui/react-toast";
import type { ReactNode } from "react";

export function ToastProvider({ children }: { children: ReactNode }) {
  return (
    <ToastPrimitive.Provider swipeDirection="right">
      {children}
      <ToastPrimitive.Viewport className="toast-viewport" />
    </ToastPrimitive.Provider>
  );
}
export function Toast({
  open,
  onOpenChange,
  message,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  message: string;
}) {
  return (
    <ToastPrimitive.Root
      className="toast"
      open={open}
      onOpenChange={onOpenChange}
    >
      <ToastPrimitive.Title>{message}</ToastPrimitive.Title>
      <ToastPrimitive.Close
        aria-label="Dismiss notification"
        className="toast-close"
      >
        ✕
      </ToastPrimitive.Close>
    </ToastPrimitive.Root>
  );
}
