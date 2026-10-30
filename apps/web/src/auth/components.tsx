import { clearPushOnSignOut } from "../push/client.ts";
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
import { activeLayout, hubHref } from "../origins.ts";
import { auth, AuthError, hasWebAuthn } from "./client.ts";
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
import { QRCodeSVG } from "qrcode.react";
import {
  ChallengeInputs,
  FactorSummary,
  errorMessage,
} from "./security-controls.tsx";

const sessionKey = ["auth", "session"];
const sessionQuery = {
  queryKey: sessionKey,
  queryFn: () => auth.session(),
  retry: false,
};
export function expireSession() {
  if (window.location.pathname === "/settings/billing")
    sessionStorage.setItem(
      returnKey,
      `${window.location.pathname}${window.location.search}`,
    );
  sessionStorage.setItem("auth-session-expired", "1");
  window.dispatchEvent(new Event("opensuite-session-expired"));
}
export function Protected({ children }: { children: ReactNode }) {
  const session = useQuery(sessionQuery);
  const navigate = useNavigate();
  const hadSession = useRef(false);
  useEffect(() => {
    if (session.data) hadSession.current = true;
    if (session.isSuccess && session.data === null) {
      const layout = activeLayout();
      if (layout.split && layout.host !== "mail") {
        // Sibling origins obtain their session from the sign-in origin;
        // after repeated failures, fall back to its sign-in page.
        if (!startHandoff()) window.location.assign(`${layout.hub}/login`);
      } else if (hadSession.current) expireSession();
      else {
        if (window.location.pathname === "/settings/billing")
          sessionStorage.setItem(
            returnKey,
            `${window.location.pathname}${window.location.search}`,
          );
        void navigate({ to: "/login" });
      }
    }
  }, [session.isSuccess, session.data, navigate]);
  if (session.isPending)
    return (
      <main className="auth-loading">
        <output>Checking your session…</output>
      </main>
    );
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
export function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [challenge, setChallenge] = useState(false);
  const [backup, setBackup] = useState(false);
  const [methods, setMethods] = useState({
    totp: false,
    securityKey: false,
    backup: false,
  });
  const [methodsError, setMethodsError] = useState(false);
  async function loadMethods() {
    setMethodsError(false);
    try {
      const available = await auth.methods();
      setMethods(available);
      setBackup(!available.totp && available.backup);
    } catch {
      setMethodsError(true);
    }
  }
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
  async function completeSignIn() {
    const session = await auth.session();
    if (session === null)
      throw new Error("Could not establish a session. Please sign in again.");
    client.setQueryData(sessionKey, session);
    const pending = sessionStorage.getItem(returnKey);
    sessionStorage.removeItem(returnKey);
    if (
      pending?.startsWith("/auth/handoff?") ||
      pending?.startsWith("/settings/billing?billing=")
    ) {
      window.location.assign(pending);
      return;
    }
    void navigate({ to: "/mail" });
  }
  async function useSecurityKey() {
    setBusy(true);
    setError("");
    try {
      await auth.verifyKey();
      await completeSignIn();
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }
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
          await loadMethods();
          return;
        }
      }
      await completeSignIn();
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }
  // Other origins never show the form: typing there would race the move.
  const here = activeLayout();
  if (here.split && here.host !== "mail")
    return (
      <main className="auth-loading">
        <output>Redirecting to sign-in…</output>
      </main>
    );
  return (
    <main className="auth-page">
      <div className="auth-card">
        <div className="brand">
          <img className="brand-mark" src="/mark.svg" alt="" />
          Esuno
        </div>
        <h1>{challenge ? "Verify your identity" : "Sign in"}</h1>
        <p>
          {expired
            ? "Your session expired. Sign in again to continue."
            : challenge
              ? "Choose a verification method."
              : "Welcome back to your workspace."}
        </p>
        <form
          onSubmit={(event) => {
            void submit(event);
          }}
          className="auth-form"
        >
          {challenge ? (
            <ChallengeInputs
              methods={methods}
              backup={backup}
              code={code}
              busy={busy}
              supported={hasWebAuthn()}
              onCode={setCode}
              onToggle={() => {
                setBackup(!backup);
                setCode("");
              }}
              onKey={() => {
                void useSecurityKey();
              }}
            />
          ) : (
            <>
              <TextField
                label="Email address (any of your Esuno addresses)"
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
          {challenge && methodsError && (
            <button
              type="button"
              className="auth-link"
              onClick={() => {
                void loadMethods();
              }}
            >
              Retry loading verification methods
            </button>
          )}
          {(challenge || error) && (
            <button
              type="button"
              className="auth-link"
              onClick={() => {
                void auth
                  .signOut()
                  .then(() => {
                    setChallenge(false);
                    setPassword("");
                    setCode("");
                    setError("");
                    setMethods({
                      totp: false,
                      securityKey: false,
                      backup: false,
                    });
                    setMethodsError(false);
                    return undefined;
                  })
                  .catch((failure: unknown) => setError(errorMessage(failure)));
              }}
            >
              Start over
            </button>
          )}
          {(!challenge || methods.totp || methods.backup) && (
            <Button type="submit" disabled={busy}>
              {busy ? "Please wait…" : challenge ? "Verify" : "Sign in"}
            </Button>
          )}
        </form>
      </div>
    </main>
  );
}
export function AccountMenu({ children }: { children?: ReactNode }) {
  const [open, setOpen] = useState(
    () => new URLSearchParams(window.location.search).get("security") === "1",
  );
  const generation = useRef(0);
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [enrollment, setEnrollment] = useState<{
    totpURI: string;
    backupCodes: string[];
  } | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [newBackupCodes, setNewBackupCodes] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [keyName, setKeyName] = useState("");
  const client = useQueryClient();
  const navigate = useNavigate();
  const session = useQuery(sessionQuery);
  const factors = useQuery({
    queryKey: ["auth", "factors"],
    queryFn: () => auth.factors(),
    enabled: open,
    retry: false,
  });
  async function refreshFactors() {
    await Promise.all([
      client.invalidateQueries({ queryKey: sessionKey }),
      client.invalidateQueries({ queryKey: ["auth", "factors"] }),
    ]);
  }
  async function manageKey(id?: string) {
    const requestGeneration = generation.current;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      if (id) {
        await auth.removeKey(id, password);
        if (generation.current !== requestGeneration) return;
        setNotice("Security key removed.");
      } else {
        const codes = await auth.addKey(password, keyName);
        if (generation.current !== requestGeneration) return;
        if (codes.length) setNewBackupCodes(codes);
        setKeyName("");
        setNotice("Security key added.");
      }
      setPassword("");
      await refreshFactors();
    } catch (failure) {
      if (generation.current === requestGeneration)
        setError(errorMessage(failure));
    } finally {
      if (generation.current === requestGeneration) setBusy(false);
    }
  }
  async function signOut() {
    try {
      // Best effort: the server also clears this session's push records on sign-out.
      await clearPushOnSignOut().catch(() => undefined);
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
  async function security(
    action: "enable" | "verify" | "disable" | "regenerate",
  ) {
    const requestGeneration = generation.current;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      if (action === "enable") {
        const result = await auth.enable(password);
        if (generation.current !== requestGeneration) return;
        setEnrollment(result);
        setPassword("");
      }
      if (action === "verify") {
        await auth.verify(code, false);
        if (generation.current !== requestGeneration) return;
        setCode("");
        setNotice(
          "Two-factor authentication enabled. Save your backup codes before closing.",
        );
        await refreshFactors();
      }
      if (action === "disable") {
        await auth.disable(password);
        if (generation.current !== requestGeneration) return;
        setPassword("");
        setEnrollment(null);
        setNotice("Authenticator app disabled.");
        await refreshFactors();
      }
      if (action === "regenerate") {
        const codes = await auth.regenerateBackupCodes(password);
        if (generation.current !== requestGeneration) return;
        setNewBackupCodes(codes);
        setPassword("");
      }
    } catch (failure) {
      if (generation.current === requestGeneration)
        setError(errorMessage(failure));
    } finally {
      if (generation.current === requestGeneration) setBusy(false);
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
              generation.current++;
              setEnrollment(null);
              setNewBackupCodes(null);
              setBusy(false);
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
          generation.current++;
          setOpen(value);
          setEnrollment(null);
          setNewBackupCodes(null);
          setBusy(false);
          if (!value) {
            setPassword("");
            setCode("");
            setEnrollment(null);
            setNewBackupCodes(null);
            setError("");
          }
        }}
      >
        <DialogContent
          title="Account security"
          description="Two-factor authentication is optional. Manage your authenticator and backup codes."
        >
          <div className="auth-form">
            {factors.isError && (
              <p role="alert">
                Could not load account security. Close and reopen this panel to
                try again.
              </p>
            )}
            {enrollment ? (
              <>
                <p>Scan this QR code with your authenticator app:</p>
                <QRCodeSVG
                  value={enrollment.totpURI}
                  size={192}
                  marginSize={4}
                  bgColor="#FFFFFF"
                  // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role
                  role="img"
                  aria-label="Authenticator setup QR code"
                />
                <p>Or enter this secret manually:</p>
                <code className="auth-secret">
                  {new URL(enrollment.totpURI).searchParams.get("secret")}
                </code>
                {enrollment.backupCodes.length > 0 ? (
                  <>
                    <p>Save these backup codes somewhere safe:</p>
                    <code className="auth-secret">
                      {enrollment.backupCodes.join("\n")}
                    </code>
                  </>
                ) : null}
                {!factors.data?.totp ? (
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
                ) : (
                  <Button onClick={() => setEnrollment(null)}>Done</Button>
                )}
              </>
            ) : newBackupCodes ? (
              <>
                <p>
                  Save these new backup codes somewhere safe.{" "}
                  {notice !== "Security key added." &&
                    "Your previous codes no longer work."}
                </p>
                <code className="auth-secret">{newBackupCodes.join("\n")}</code>
                <Button onClick={() => setNewBackupCodes(null)}>Done</Button>
              </>
            ) : (
              <>
                <FactorSummary
                  totp={factors.data?.totp ?? false}
                  {...(session.data?.user.twoFactorEnabled && factors.data
                    ? { count: factors.data.backupCodesRemaining }
                    : {})}
                />
                <TextField
                  label="Current password"
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
                <Button
                  disabled={busy || !password || !factors.data}
                  onClick={() => {
                    void security(factors.data?.totp ? "disable" : "enable");
                  }}
                >
                  {factors.data?.totp
                    ? "Disable authenticator app"
                    : "Set up two-factor authentication"}
                </Button>
                <p>Security keys</p>
                {factors.data?.keys.map((key) => (
                  <div key={key.id}>
                    <p>
                      {key.name} — Added{" "}
                      {new Date(key.createdAt).toLocaleDateString()}
                      {key.lastUsedAt
                        ? `; last used ${new Date(key.lastUsedAt).toLocaleDateString()}`
                        : ""}
                    </p>
                    <Button
                      disabled={busy || !password || !factors.data}
                      onClick={() => {
                        void manageKey(key.id);
                      }}
                    >
                      Remove {key.name}
                    </Button>
                  </div>
                ))}
                {!hasWebAuthn() && (
                  <p>Security keys are not supported by this browser.</p>
                )}
                {activeLayout().split && activeLayout().host !== "mail" ? (
                  <a href={hubHref(activeLayout(), "/mail?security=1")}>
                    Add security key on the sign-in address
                  </a>
                ) : (
                  <>
                    <TextField
                      label="Security key name"
                      value={keyName}
                      onChange={(event) => setKeyName(event.target.value)}
                    />
                    <Button
                      disabled={
                        busy ||
                        !password ||
                        !keyName.trim() ||
                        !hasWebAuthn() ||
                        !factors.data
                      }
                      onClick={() => {
                        void manageKey();
                      }}
                    >
                      Add security key
                    </Button>
                  </>
                )}
                {session.data?.user.twoFactorEnabled && (
                  <Button
                    disabled={busy || !password || !factors.data}
                    onClick={() => {
                      void security("regenerate");
                    }}
                  >
                    Regenerate backup codes
                  </Button>
                )}
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
