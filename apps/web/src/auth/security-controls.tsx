import * as React from "react";
import { useEffect, useRef, useState, type ComponentProps } from "react";
import { Button } from "../ui/button.tsx";
import { TextField } from "../ui/text-field.tsx";
import { useToast } from "../ui/toast.tsx";

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

/** One line under "Verify your identity" that matches the inputs shown. */
export function challengeHint(
  methods: { totp: boolean; backup: boolean; securityKey: boolean },
  backup: boolean,
  failed: boolean,
) {
  if (failed) return "Could not load your verification methods.";
  if (methods.totp || methods.backup)
    return backup
      ? "Enter one of your backup codes."
      : "Enter the 6-digit code from your authenticator app.";
  return methods.securityKey
    ? "Use your security key to continue."
    : "Loading your verification methods…";
}

/** Authenticator codes are often copied with a space in the middle. */
export const authenticatorCode = (value: string) => value.replace(/\s/g, "");

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
  const codeField = methods.totp || methods.backup;
  const keyReady = methods.securityKey && supported && !busy;
  const field = useRef<HTMLInputElement>(null);
  const keyButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    // This screen replaces the password form, whose button had focus. The
    // methods load after it appears, and the key button waits for `busy`.
    if (codeField) field.current?.focus();
    else if (keyReady) keyButton.current?.focus();
  }, [codeField, keyReady]);
  return (
    <>
      {codeField && (
        <TextField
          ref={field}
          label={backup ? "Backup code" : "Authenticator code"}
          value={code}
          onChange={(event) => onCode(event.target.value)}
          autoComplete="one-time-code"
          {...(backup ? {} : { inputMode: "numeric" as const })}
          required
        />
      )}
      {methods.totp && methods.backup && (
        <button
          type="button"
          className="auth-link"
          onClick={() => {
            onToggle();
            field.current?.focus();
          }}
        >
          {backup ? "Use an authenticator code" : "Use a backup code"}
        </button>
      )}
      {methods.securityKey &&
        (supported ? (
          <button
            ref={keyButton}
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

/** A password field with a button that shows or hides what was typed. */
function PasswordField(props: Omit<ComponentProps<typeof TextField>, "type">) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="auth-password">
      <TextField {...props} type={visible ? "text" : "password"} />
      <button
        type="button"
        className="auth-link auth-reveal"
        aria-pressed={visible}
        onClick={() => setVisible(!visible)}
      >
        {visible ? "Hide password" : "Show password"}
      </button>
    </div>
  );
}

/** Email and password of the sign-in form, with help for a lost password. */
export function CredentialFields({
  email,
  password,
  onEmail,
  onPassword,
}: {
  email: string;
  password: string;
  onEmail: (value: string) => void;
  onPassword: (value: string) => void;
}) {
  return (
    <>
      <TextField
        label="Email address (any of your Esuno addresses)"
        type="email"
        autoComplete="username"
        value={email}
        onChange={(event) => onEmail(event.target.value)}
        required
      />
      <PasswordField
        label="Password"
        autoComplete="current-password"
        value={password}
        onChange={(event) => onPassword(event.target.value)}
        required
      />
      <p className="auth-hint">
        Forgot your password? Contact your administrator.
      </p>
    </>
  );
}

/** Backup codes with ways to keep them: copy all, or save a text file. */
export function BackupCodes({ codes }: { codes: string[] }) {
  const { notify } = useToast();
  const text = `${codes.join("\n")}\n`;
  return (
    <div className="auth-backup">
      <code className="auth-secret">{codes.join("\n")}</code>
      <div className="auth-backup-actions">
        <Button
          type="button"
          variant="secondary"
          size="small"
          onClick={() => {
            void Promise.resolve()
              .then(() => navigator.clipboard.writeText(text))
              .then(
                () => notify({ message: "Backup codes copied." }),
                () =>
                  notify({
                    message:
                      "Could not copy. Select the codes and copy them manually.",
                  }),
              );
          }}
        >
          Copy codes
        </Button>
        <Button
          type="button"
          variant="secondary"
          size="small"
          onClick={() => {
            const url = URL.createObjectURL(
              new Blob([text], { type: "text/plain" }),
            );
            const link = document.createElement("a");
            link.href = url;
            link.download = "esuno-backup-codes.txt";
            link.click();
            // Some browsers read the file after the click returns.
            setTimeout(() => URL.revokeObjectURL(url), 60_000);
          }}
        >
          Download (.txt)
        </Button>
      </div>
    </div>
  );
}
