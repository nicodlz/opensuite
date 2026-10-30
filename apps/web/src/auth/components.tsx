import * as React from "react";
import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { activeLayout } from "../origins.ts";
import { auth, AuthError } from "./client.ts";
import { returnKey, startHandoff } from "./handoff.tsx";
import { Button } from "../ui/button.tsx";
import { Dialog, DialogContent } from "../ui/dialog.tsx";
import {
  DropdownContent,
  DropdownMenu,
  DropdownTrigger,
  DropdownItem,
} from "../ui/dropdown-menu.tsx";
import { TextField } from "../ui/text-field.tsx";

const sessionKey = ["auth", "session"];
const sessionQuery = {
  queryKey: sessionKey,
  queryFn: () => auth.session(),
  retry: false,
};
export function expireSession() {
  sessionStorage.setItem("auth-session-expired", "1");
  window.dispatchEvent(new Event("opensuite-session-expired"));
}
export function Protected({ children }: { children: ReactNode }) {
  const session = useQuery(sessionQuery);
  const navigate = useNavigate();
  const hadSession = useRef(false);
  const [stuck, setStuck] = useState(false);
  useEffect(() => {
    if (session.data) hadSession.current = true;
    if (session.isSuccess && session.data === null) {
      const layout = activeLayout();
      if (layout.split && layout.host !== "mail") {
        // Sibling origins obtain their session from the sign-in origin.
        if (!startHandoff()) setStuck(true);
      } else if (hadSession.current) expireSession();
      else void navigate({ to: "/login" });
    }
  }, [session.isSuccess, session.data, navigate]);
  if (stuck)
    return (
      <main className="auth-loading" role="alert">
        Could not sign you in automatically.{" "}
        <Button asChild>
          <a href={`${activeLayout().hub}/login`}>Sign in</a>
        </Button>
      </main>
    );
  if (session.isPending)
    return <main className="auth-loading">Checking your session…</main>;
  if (session.isError)
    return (
      <main className="auth-loading" role="alert">
        Could not check your session.{" "}
        <Button
          onClick={() => {
            void session.refetch();
          }}
        >
          Try again
        </Button>
      </main>
    );
  if (session.data === null) return null;
  return <>{children}</>;
}
function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Please try again.";
}
export function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [challenge, setChallenge] = useState(false);
  const [backup, setBackup] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [expired] = useState(() => {
    const value = sessionStorage.getItem("auth-session-expired") === "1";
    sessionStorage.removeItem("auth-session-expired");
    return value;
  });
  const client = useQueryClient();
  const navigate = useNavigate();
  useEffect(() => {
    // Only the sign-in origin shows the sign-in form.
    const layout = activeLayout();
    if (layout.split && layout.host !== "mail")
      window.location.replace(`${layout.hub}/login`);
  }, []);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      if (challenge) await auth.verify(code, backup);
      else {
        const result = await auth.signIn(email, password);
        if (result.twoFactorRedirect) {
          setPassword("");
          setChallenge(true);
          return;
        }
      }
      const session = await auth.session();
      if (session === null)
        throw new Error("Could not establish a session. Please sign in again.");
      client.setQueryData(sessionKey, session);
      const pending = sessionStorage.getItem(returnKey);
      sessionStorage.removeItem(returnKey);
      if (pending?.startsWith("/auth/handoff?")) {
        window.location.assign(pending);
        return;
      }
      void navigate({ to: "/mail" });
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="auth-page">
      <div className="auth-card">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            ✳
          </span>{" "}
          OpenSuite
        </div>
        <h1>{challenge ? "Verify your identity" : "Sign in"}</h1>
        <p>
          {expired
            ? "Your session expired. Sign in again to continue."
            : challenge
              ? "Enter a code from your authenticator or use a backup code."
              : "Welcome back to your workspace."}
        </p>
        <form
          onSubmit={(event) => {
            void submit(event);
          }}
          className="auth-form"
        >
          {challenge ? (
            <>
              <TextField
                label={backup ? "Backup code" : "Authenticator code"}
                value={code}
                onChange={(event) => setCode(event.target.value)}
                autoComplete="one-time-code"
                required
              />
              <button
                type="button"
                className="auth-link"
                onClick={() => {
                  setBackup(!backup);
                  setCode("");
                }}
              >
                {backup ? "Use an authenticator code" : "Use a backup code"}
              </button>
            </>
          ) : (
            <>
              <TextField
                label="Email"
                type="email"
                autoComplete="username"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                required
              />
              <TextField
                label="Password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
              />
            </>
          )}
          {error && (
            <p role="alert" className="field-error">
              {error}
            </p>
          )}
          <Button type="submit" disabled={busy}>
            {busy ? "Please wait…" : challenge ? "Verify" : "Sign in"}
          </Button>
        </form>
      </div>
    </main>
  );
}
export function AccountMenu({ children }: { children?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [enrollment, setEnrollment] = useState<{
    totpURI: string;
    backupCodes: string[];
  } | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const client = useQueryClient();
  const navigate = useNavigate();
  const session = useQuery(sessionQuery);
  async function signOut() {
    try {
      await auth.signOut();
    } catch (failure) {
      if (failure instanceof AuthError && failure.status === 401) {
        expireSession();
        return;
      }
      setError(errorMessage(failure));
      setOpen(true);
      return;
    }
    await client.cancelQueries();
    client.clear();
    void navigate({ to: "/login" });
  }
  async function security(action: "enable" | "verify" | "disable") {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      if (action === "enable") {
        setEnrollment(await auth.enable(password));
        setPassword("");
      }
      if (action === "verify") {
        await auth.verify(code, false);
        setCode("");
        setNotice(
          "Two-factor authentication enabled. Save your backup codes before closing.",
        );
        await client.invalidateQueries({ queryKey: sessionKey });
      }
      if (action === "disable") {
        await auth.disable(password);
        setPassword("");
        setEnrollment(null);
        setNotice("Two-factor authentication disabled.");
        await client.invalidateQueries({ queryKey: sessionKey });
      }
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <DropdownMenu>
        <DropdownTrigger asChild>
          <Button
            variant="ghost"
            size="small"
            className="shell-avatar-button"
            aria-label="Account menu"
          >
            <span className="avatar" aria-hidden="true">
              {(session.data?.user.email ?? "?").charAt(0).toUpperCase()}
            </span>
          </Button>
        </DropdownTrigger>
        <DropdownContent>
          <div className="menu-label menu-account">
            {session.data?.user.email}
          </div>
          <DropdownItem
            className="menu-item"
            onSelect={() => {
              setOpen(true);
              setError("");
              setNotice("");
            }}
          >
            Account security
          </DropdownItem>
          {children && (
            <>
              <div className="menu-separator" />
              {children}
              <div className="menu-separator" />
            </>
          )}
          <DropdownItem
            className="menu-item"
            onSelect={() => {
              void signOut();
            }}
          >
            Sign out
          </DropdownItem>
        </DropdownContent>
      </DropdownMenu>
      <Dialog
        open={open}
        onOpenChange={(value) => {
          setOpen(value);
          if (!value) {
            setPassword("");
            setCode("");
            setEnrollment(null);
            setError("");
          }
        }}
      >
        <DialogContent
          title="Account security"
          description="Manage two-factor authentication for your account."
        >
          <div className="auth-form">
            {enrollment ? (
              <>
                <p>Add this setup URI to your authenticator:</p>
                <code className="auth-secret">{enrollment.totpURI}</code>
                <p>Save these backup codes somewhere safe:</p>
                <code className="auth-secret">
                  {enrollment.backupCodes.join("\n")}
                </code>
                {!session.data?.user.twoFactorEnabled && (
                  <>
                    <TextField
                      label="Authenticator code"
                      value={code}
                      onChange={(event) => setCode(event.target.value)}
                      autoComplete="one-time-code"
                    />
                    <Button
                      disabled={busy || !code}
                      onClick={() => {
                        void security("verify");
                      }}
                    >
                      Confirm setup
                    </Button>
                  </>
                )}
              </>
            ) : (
              <>
                <p>
                  {session.data?.user.twoFactorEnabled
                    ? "Two-factor authentication is enabled."
                    : "Two-factor authentication is not enabled."}
                </p>
                <TextField
                  label="Current password"
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
                <Button
                  disabled={busy || !password}
                  onClick={() => {
                    void security(
                      session.data?.user.twoFactorEnabled
                        ? "disable"
                        : "enable",
                    );
                  }}
                >
                  {session.data?.user.twoFactorEnabled
                    ? "Disable two-factor authentication"
                    : "Set up two-factor authentication"}
                </Button>
              </>
            )}
            {error && (
              <p role="alert" className="field-error">
                {error}
              </p>
            )}
            {notice && <output>{notice}</output>}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
