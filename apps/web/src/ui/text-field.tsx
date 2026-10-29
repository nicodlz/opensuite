import * as React from "react";
import * as Label from "@radix-ui/react-label";
import { useId, type ComponentProps } from "react";

type TextFieldProps = Omit<ComponentProps<"input">, "id"> & {
  label: string;
  description?: string;
  error?: string;
};

export function TextField({
  label,
  description,
  error,
  ...props
}: TextFieldProps) {
  const id = useId();
  const descriptionId = `${id}-description`;
  const errorId = `${id}-error`;
  const describedBy = [description ? descriptionId : "", error ? errorId : ""]
    .filter(Boolean)
    .join(" ");
  return (
    <div className="field">
      <Label.Root className="field-label" htmlFor={id}>
        {label}
      </Label.Root>
      {description && (
        <p className="field-description" id={descriptionId}>
          {description}
        </p>
      )}
      <input
        {...props}
        id={id}
        className="field-input"
        aria-invalid={Boolean(error)}
        aria-describedby={describedBy || undefined}
      />
      {error && (
        <p className="field-error" id={errorId}>
          {error}
        </p>
      )}
    </div>
  );
}
