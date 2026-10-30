import * as React from "react";
import { TextField } from "../ui/text-field.tsx";

export function errorMessage(error: unknown) {
  if (
    error instanceof Error &&
    ["NotAllowedError", "AbortError", "TimeoutError"].includes(error.name)
  )
    return "Security key request cancelled or timed out. Please try again.";
  if (error instanceof Error && error.name === "InvalidStateError")
    return "This security key is already registered or unavailable.";
  if (error instanceof Error && error.name === "SecurityError")
    return "Security keys must be used on the sign-in address.";
  return error instanceof Error ? error.message : "Please try again.";
}

export function ChallengeInputs({
  methods,
  backup,
  code,
  busy,
  supported,
  onCode,
  onToggle,
  onKey,
}: {
  methods: { totp: boolean; backup: boolean; securityKey: boolean };
  backup: boolean;
  code: string;
  busy: boolean;
  supported: boolean;
  onCode: (value: string) => void;
  onToggle: () => void;
  onKey: () => void;
}) {
  return (
    <>
      {(methods.totp || methods.backup) && (
        <TextField
          label={backup ? "Backup code" : "Authenticator code"}
          value={code}
          onChange={(event) => onCode(event.target.value)}
          autoComplete="one-time-code"
          required
        />
      )}
      {methods.totp && methods.backup && (
        <button type="button" className="auth-link" onClick={onToggle}>
          {backup ? "Use an authenticator code" : "Use a backup code"}
        </button>
      )}
      {methods.securityKey &&
        (supported ? (
          <button
            type="button"
            className="auth-link"
            disabled={busy}
            onClick={onKey}
          >
            Use security key
          </button>
        ) : (
          <p>Security keys are not supported by this browser.</p>
        ))}
    </>
  );
}

export function FactorSummary({
  totp,
  count,
}: {
  totp: boolean;
  count?: number;
}) {
  return (
    <>
      <p>Authenticator app: {totp ? "on" : "off"}</p>
      {count !== undefined && <p>Backup codes remaining: {count}</p>}
    </>
  );
}
