import * as React from "react";
import { themeChoices, type ThemeChoice } from "@opensuite/design-tokens";
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from "@tanstack/react-query";
import {
  Link,
  Outlet,
  RouterProvider,
  createRootRoute,
  createRoute,
  createRouter,
  useRouterState,
} from "@tanstack/react-router";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { createRoot } from "react-dom/client";
import { MailPage } from "./mail/mail-page.tsx";
import { DrivePage } from "./drive/drive-page.tsx";
import { getHealth, getReadiness } from "./api.ts";
import { Button } from "./ui/button.tsx";
import { Dialog, DialogContent, DialogTrigger } from "./ui/dialog.tsx";
import {
  DropdownContent,
  DropdownItemIndicator,
  DropdownMenu,
  DropdownRadioGroup,
  DropdownRadioItem,
  DropdownTrigger,
} from "./ui/dropdown-menu.tsx";
import { useKeyboardShortcut } from "./ui/keyboard-shortcut.ts";
import { TextField } from "./ui/text-field.tsx";
import { Toast, ToastProvider } from "./ui/toast.tsx";

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchInterval: 30_000 } },
});

function initialTheme(): ThemeChoice {
  const stored = localStorage.getItem("opensuite-theme");
  return stored === "light" || stored === "dark" ? stored : "system";
}

function Shell() {
  const product = useRouterState({
    select: (state) => state.location.pathname,
  });
  const [theme, setTheme] = useState<ThemeChoice>(initialTheme);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [label, setLabel] = useState(
    () => localStorage.getItem("opensuite-label") || "My workspace",
  );
  const [draft, setDraft] = useState(label);
  const [error, setError] = useState("");
  const [toastOpen, setToastOpen] = useState(false);
  useEffect(() => {
    if (theme === "system") delete document.documentElement.dataset["theme"];
    else document.documentElement.dataset["theme"] = theme;
    localStorage.setItem("opensuite-theme", theme);
  }, [theme]);
  const openSettings = useCallback(() => setSettingsOpen(true), []);
  useKeyboardShortcut("s", openSettings);
  function saveLabel(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = draft.trim();
    if (!value) {
      setError("Enter a workspace label.");
      return;
    }
    localStorage.setItem("opensuite-label", value);
    setLabel(value);
    setError("");
    setSettingsOpen(false);
    setToastOpen(true);
  }
  function changeTheme(value: string) {
    if (value === "system" || value === "light" || value === "dark")
      setTheme(value);
  }
  if (product === "/mail") return <MailPage />;
  if (product === "/drive") return <DrivePage />;
  return (
    <ToastProvider>
      <a href="#main-content" className="skip-link">
        Skip to content
      </a>
      <div className="app-shell bg-canvas text-ink font-sans">
        <aside className="sidebar">
          <Link to="/" className="brand">
            <span className="brand-mark" aria-hidden="true">
              ✳
            </span>
            <span>OpenSuite</span>
          </Link>
          <div className="workspace-caption">WORKSPACE</div>
          <p className="workspace-name">{label}</p>
          <Button
            className="compose-button"
            disabled
            title="Mail is not available yet"
          >
            <span aria-hidden="true">＋</span> New message
          </Button>
          <p className="sidebar-hint">Mail is not available yet</p>
          <nav aria-label="Products" className="product-nav">
            <span className="nav-heading">PRODUCTS</span>
            <Link to="/mail" className="nav-link">
              <span aria-hidden="true">✉</span> Mail
            </Link>
            <Link to="/calendar" className="nav-link">
              <span aria-hidden="true">▦</span> Calendar
            </Link>
            <Link to="/contacts" className="nav-link">
              <span aria-hidden="true">♙</span> Contacts
            </Link>
            <Link to="/drive" className="nav-link">
              <span aria-hidden="true">◇</span> Drive
            </Link>
          </nav>
          <div className="folders" aria-label="Mail folders">
            <span className="nav-heading">MAIL FOLDERS</span>
            <span>
              Inbox <small>Unavailable</small>
            </span>
            <span>Drafts</span>
            <span>Sent</span>
            <span>Archive</span>
            <span className="nav-heading labels-heading">LABELS</span>
            <span>No labels yet</span>
          </div>
          <div className="sidebar-bottom">
            <Link to="/" className="nav-link">
              <span aria-hidden="true">◉</span> System status
            </Link>
          </div>
        </aside>
        <div className="app-body">
          <header className="topbar">
            <div className="search-shell">
              <span aria-hidden="true">⌕</span>
              <label htmlFor="search">Search</label>
              <input
                id="search"
                placeholder="Search is not available yet"
                disabled
              />
            </div>
            <div className="top-actions">
              <span className="top-caption">YOUR WORKSPACE</span>
              <Dialog
                open={settingsOpen}
                onOpenChange={(open) => {
                  setSettingsOpen(open);
                  if (open) {
                    setDraft(label);
                    setError("");
                  }
                }}
              >
                <DialogTrigger asChild>
                  <Button variant="ghost" size="small">
                    Settings <kbd>S</kbd>
                  </Button>
                </DialogTrigger>
                <DialogContent
                  title="Workspace settings"
                  description="Choose a label for this browser. It is stored locally."
                >
                  <form onSubmit={saveLabel} noValidate>
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
                </DialogContent>
              </Dialog>
              <DropdownMenu>
                <DropdownTrigger asChild>
                  <Button
                    variant="ghost"
                    size="small"
                    aria-label="Account and appearance menu"
                  >
                    <span className="avatar" aria-hidden="true">
                      O
                    </span>
                    <span className="account-text">Account</span>
                    <span aria-hidden="true">⌄</span>
                  </Button>
                </DropdownTrigger>
                <DropdownContent>
                  <div className="menu-label">Account unavailable</div>
                  <div className="menu-separator" />
                  <div className="menu-label">Appearance</div>
                  <DropdownRadioGroup value={theme} onValueChange={changeTheme}>
                    {themeChoices.map((choice) => (
                      <DropdownRadioItem
                        key={choice}
                        className="menu-item"
                        value={choice}
                      >
                        <span className="menu-indicator">
                          <DropdownItemIndicator>✓</DropdownItemIndicator>
                        </span>
                        {choice === "system"
                          ? "Use system theme"
                          : `${choice.charAt(0).toUpperCase()}${choice.slice(1)} theme`}
                      </DropdownRadioItem>
                    ))}
                  </DropdownRadioGroup>
                </DropdownContent>
              </DropdownMenu>
            </div>
          </header>
          <main id="main-content" tabIndex={-1}>
            <Outlet />
          </main>
        </div>
      </div>
      <Toast
        open={toastOpen}
        onOpenChange={setToastOpen}
        message="Workspace label saved on this device"
      />
    </ToastProvider>
  );
}

function StatusPage() {
  const health = useQuery({ queryKey: ["health"], queryFn: getHealth });
  const readiness = useQuery({
    queryKey: ["readiness"],
    queryFn: getReadiness,
  });
  const loading = health.isPending || readiness.isPending;
  const unavailable = health.isError || readiness.isError;
  const degraded = readiness.data?.status === "not_ready";
  const overview = loading
    ? "Checking services"
    : unavailable
      ? "Some checks are unavailable"
      : degraded
        ? "Attention needed"
        : "All checks operational";
  return (
    <div className="content-wrap">
      <div className="page-breadcrumb">
        WORKSPACE <span>/</span> SYSTEM STATUS
      </div>
      <div className="page-header">
        <div>
          <p className="eyebrow">YOUR INSTALLATION</p>
          <h1>System status</h1>
          <p className="page-subtitle">
            A live view of your OpenSuite API and its dependencies.
          </p>
        </div>
        <Button
          variant="secondary"
          onClick={() => {
            void health.refetch();
            void readiness.refetch();
          }}
          disabled={health.isFetching || readiness.isFetching}
        >
          <span aria-hidden="true">↻</span> Refresh checks
        </Button>
      </div>
      <section
        className="overview-card"
        aria-labelledby="overview-heading"
        aria-live="polite"
      >
        <div
          className={`overview-icon ${unavailable ? "danger" : degraded ? "warning" : "success"}`}
          aria-hidden="true"
        >
          {loading ? "…" : unavailable ? "!" : degraded ? "!" : "✓"}
        </div>
        <div>
          <p className="eyebrow">CURRENT OVERVIEW</p>
          <h2 id="overview-heading">{overview}</h2>
          <p>
            {loading
              ? "Waiting for the API to respond."
              : unavailable
                ? "A check could not be completed. Check your connection and try again."
                : degraded
                  ? "One or more dependencies need attention."
                  : "The API is responding and its readiness check passed."}
          </p>
        </div>
        <span className="live-label">
          <span className="live-dot" /> LIVE CHECKS
        </span>
      </section>
      <div className="section-heading">
        <div>
          <p className="eyebrow">SERVICE CHECKS</p>
          <h2>API health</h2>
          <p>Checks refresh automatically every 30 seconds.</p>
        </div>
      </div>
      <div className="checks-grid">
        <article className="check-card">
          <div className="check-top">
            <div className="check-icon" aria-hidden="true">
              ♡
            </div>
            <StatusBadge
              state={
                health.isPending ? "loading" : health.isError ? "error" : "ok"
              }
            />
          </div>
          <h3>Liveness</h3>
          <p>Confirms the API process is responding.</p>
          <div className="check-detail">
            {health.isPending
              ? "Waiting for response"
              : health.isError
                ? "Unable to reach or validate the API"
                : `Uptime: ${Math.floor(health.data.uptimeSeconds)} seconds`}
          </div>
          <code>GET /api/health</code>
        </article>
        <article className="check-card">
          <div className="check-top">
            <div className="check-icon" aria-hidden="true">
              ◈
            </div>
            <StatusBadge
              state={
                readiness.isPending
                  ? "loading"
                  : readiness.isError
                    ? "error"
                    : degraded
                      ? "degraded"
                      : "ok"
              }
            />
          </div>
          <h3>Readiness</h3>
          <p>Checks whether declared dependencies are available.</p>
          <div className="check-detail">
            {readiness.isPending
              ? "Waiting for response"
              : readiness.isError
                ? "Unable to reach or validate the API"
                : readiness.data.dependencies.length === 0
                  ? "No dependencies declared"
                  : `${readiness.data.dependencies.filter((dependency) => dependency.status === "up").length} of ${readiness.data.dependencies.length} dependencies up`}
          </div>
          <code>GET /api/ready</code>
        </article>
      </div>
      {readiness.data && readiness.data.dependencies.length > 0 && (
        <section className="dependency-card">
          <h2>Dependencies</h2>
          <ul>
            {readiness.data.dependencies.map((dependency) => (
              <li key={dependency.name}>
                <span>{dependency.name}</span>
                <StatusBadge
                  state={dependency.status === "up" ? "ok" : "degraded"}
                />
              </li>
            ))}
          </ul>
        </section>
      )}
      <p className="status-footnote">Status reflects these API checks only.</p>
    </div>
  );
}

type BadgeState = "loading" | "ok" | "degraded" | "error";
function StatusBadge({ state }: { state: BadgeState }) {
  const labels: Record<BadgeState, string> = {
    loading: "Checking",
    ok: "Operational",
    degraded: "Degraded",
    error: "Unavailable",
  };
  return (
    <span className={`status-badge status-${state}`}>
      <span aria-hidden="true">●</span> {labels[state]}
    </span>
  );
}
function ProductPlaceholder({ name }: { name: string }) {
  return (
    <div className="content-wrap">
      <div className="page-breadcrumb">
        WORKSPACE <span>/</span> {name.toUpperCase()}
      </div>
      <div className="page-header">
        <div>
          <p className="eyebrow">PRODUCTS</p>
          <h1>{name}</h1>
          <p className="page-subtitle">
            {name} is not available in the web app yet.
          </p>
        </div>
      </div>
      <section className="empty-card">
        <div className="check-icon" aria-hidden="true">
          ◇
        </div>
        <h2>Coming later</h2>
        <p>
          This area is reserved for {name.toLowerCase()}. You can check your
          installation while it is being built.
        </p>
        <Button asChild variant="secondary">
          <Link to="/">View system status</Link>
        </Button>
      </section>
    </div>
  );
}

const rootRoute = createRootRoute({ component: Shell });
const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: StatusPage,
});
const mailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/mail",
  component: MailPage,
});
const calendarRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/calendar",
  component: () => <ProductPlaceholder name="Calendar" />,
});
const contactsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/contacts",
  component: () => <ProductPlaceholder name="Contacts" />,
});
const driveRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/drive",
  component: DrivePage,
});
const router = createRouter({
  routeTree: rootRoute.addChildren([
    indexRoute,
    mailRoute,
    calendarRoute,
    contactsRoute,
    driveRoute,
  ]),
});
declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
const root = document.getElementById("root");
if (!root) throw new Error("Root element missing");
createRoot(root).render(
  <QueryClientProvider client={queryClient}>
    <RouterProvider router={router} />
  </QueryClientProvider>,
);
