import * as React from "react";
import { Navigate, useRouterState } from "@tanstack/react-router";
import { useCallback, useState, type FormEvent, type ReactNode } from "react";
import { Button } from "../ui/button.tsx";
import { Dialog, DialogContent } from "../ui/dialog.tsx";
import { useKeyboardShortcut } from "../ui/keyboard-shortcut.ts";
import { TextField } from "../ui/text-field.tsx";
import { useToast } from "../ui/toast.tsx";
import { StatusPage } from "./admin-pages.tsx";
import {
  AppShell,
  PageLoading,
  SidebarItem,
  SidebarLink,
  type Product,
} from "./app-shell.tsx";
import { useOptionalSession } from "./session.ts";
import { storeWorkspaceLabel, useWorkspaceLabel } from "./workspace-label.ts";

const adminPages = [
  { to: "/status", label: "System status", icon: "status" },
  { to: "/setup", label: "Setup wizard", icon: "sparkle" },
  { to: "/domains", label: "Domains", icon: "globe" },
] as const;
/** The status page also answers at the root for visitors without a session. */
const adminPage = (path: string) =>
  adminPages.find(
    (page) => page.to === path || (page.to === "/status" && path === "/"),
  );

function WorkspaceLabelForm({
  label,
  onSave,
}: {
  label: string;
  onSave: (value: string) => void;
}) {
  const [draft, setDraft] = useState(label);
  const [error, setError] = useState("");
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = draft.trim();
    if (!value) {
      setError("Enter a workspace label.");
      return;
    }
    onSave(value);
  }
  return (
    <form onSubmit={submit} noValidate>
      <TextField
        label="Workspace label"
        description="Visible in the sidebar on this device."
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        maxLength={40}
        error={error}
      />
      <div className="dialog-actions">
        <Button type="submit">Save label</Button>
      </div>
    </form>
  );
}

function AdminSidebar({
  label,
  path,
  onSettings,
}: {
  label: string;
  path: string;
  onSettings: () => void;
}) {
  const current = adminPage(path);
  return (
    <>
      <p className="shell-nav-heading">Workspace</p>
      <p className="admin-workspace-name">{label}</p>
      <p className="shell-nav-heading">Administration</p>
      {adminPages.map((link) => (
        <SidebarLink
          key={link.to}
          to={link.to}
          icon={link.icon}
          label={link.label}
          active={link === current}
        />
      ))}
      <SidebarItem
        icon="settings"
        label="Workspace settings"
        onClick={onSettings}
        aria-keyshortcuts="S"
      />
    </>
  );
}

/** Frame for the administration pages and the Contacts placeholder. */
export function AdminShell({
  product = "admin",
  signedIn = true,
  children,
}: {
  product?: Product;
  signedIn?: boolean;
  children: ReactNode;
}) {
  const path = useRouterState({ select: (state) => state.location.pathname });
  const label = useWorkspaceLabel();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const { notify } = useToast();
  const openSettings = useCallback(() => setSettingsOpen(true), []);
  useKeyboardShortcut("s", openSettings);
  function saveLabel(value: string) {
    const previous = storeWorkspaceLabel(value);
    setSettingsOpen(false);
    notify({
      message: "Workspace label saved on this device",
      action: { label: "Undo", onAction: () => storeWorkspaceLabel(previous) },
    });
  }
  const page = product === "admin" ? adminPage(path) : undefined;
  return (
    <>
      <AppShell
        product={product}
        signedIn={signedIn}
        {...(page ? { title: page.label } : {})}
        sidebar={
          product === "admin" && (
            <AdminSidebar label={label} path={path} onSettings={openSettings} />
          )
        }
      >
        {children}
      </AppShell>
      <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
        <DialogContent
          title="Workspace settings"
          description="Choose a label for this browser. It is stored locally."
        >
          <WorkspaceLabelForm label={label} onSave={saveLabel} />
        </DialogContent>
      </Dialog>
    </>
  );
}

/** A failed session check, with a way to try again. */
function SessionProblem({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="session-problem" role="alert">
      <p>Could not check your session. Account controls are unavailable.</p>
      <Button variant="secondary" size="small" onClick={onRetry}>
        Try again
      </Button>
    </div>
  );
}

/**
 * System status in the shell that matches the visitor's session. At the root,
 * a signed-in user goes to Mail instead. A failed session check is shown, not
 * treated as signed out.
 */
export function StatusScreen({ home }: { home: boolean }) {
  const session = useOptionalSession();
  if (session.state === "pending") return <PageLoading />;
  if (home && session.state === "signed-in")
    return <Navigate to="/mail" replace />;
  return (
    <AdminShell signedIn={session.state === "signed-in"}>
      {session.state === "failed" && <SessionProblem onRetry={session.retry} />}
      <StatusPage />
    </AdminShell>
  );
}
