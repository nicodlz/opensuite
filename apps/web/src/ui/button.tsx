import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";

const buttonStyles = cva("button", {
  variants: {
    variant: {
      primary: "button-primary",
      secondary: "button-secondary",
      ghost: "button-ghost",
    },
    size: { normal: "button-normal", small: "button-small" },
  },
  defaultVariants: { variant: "primary", size: "normal" },
});

type ButtonProps = ComponentProps<"button"> &
  VariantProps<typeof buttonStyles> & { asChild?: boolean };

export function Button({
  asChild,
  variant,
  size,
  className,
  ...props
}: ButtonProps) {
  const Component = asChild ? Slot : "button";
  return (
    <Component
      className={buttonStyles({ variant, size, className })}
      {...props}
    />
  );
}
