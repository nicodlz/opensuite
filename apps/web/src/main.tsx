import * as React from "react";
import {
  QueryClient,
  QueryCache,
  MutationCache,
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
import {
  lazy,
  Suspense,
  useCallback,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { createRoot } from "react-dom/client";

import { ORPCError } from "@orpc/client";
import { AuthError } from "./auth/client.ts";
import { LoginPage, Protected, expireSession } from "./auth/components.tsx";
import { CallbackPage, HandoffPage, startHandoff } from "./auth/handoff.tsx";
import {
  loadOrigins,
  redirectFor,
  resolveLayout,
  rewriteFor,
  setActiveLayout,
} from "./origins.ts";
import { MailPage } from "./mail/mail-page.tsx";
import { getHealth, getReadiness } from "./api.ts";
import {
  AppShell,
  SidebarItem,
  SidebarLink,
  type Product,
} from "./shell/app-shell.tsx";
import { Button } from "./ui/button.tsx";
import { Dialog, DialogContent } from "./ui/dialog.tsx";
import { useKeyboardShortcut } from "./ui/keyboard-shortcut.ts";
import { TextField } from "./ui/text-field.tsx";
import { Toast, ToastProvider } from "./ui/toast.tsx";

// Each application may have its own origin; decide routing before render.
const layout = resolveLayout(await loadOrigins(), window.location.origin);
setActiveLayout(layout);
const moved = redirectFor(
  layout,
  window.location.pathname,
  window.location.search,
  window.location.hash,
);
if (moved !== null && /^https?:/.test(moved)) window.location.replace(moved);
else if (moved !== null) window.history.replaceState(null, "", moved);

const DrivePage = lazy(() =>
  import("./drive/drive-page.tsx").then((module) => ({
    default: module.DrivePage,
  })),
);
const CalendarPage = lazy(() =>
  import("./calendar/calendar-page.tsx").then((module) => ({
    default: module.CalendarPage,
  })),
);
const PassPage = lazy(() =>
  import("./pass/pass-page.tsx").then((module) => ({
    default: module.PassPage,
  })),
);
const SetupPage = lazy(() =>
  import("./setup/setup-page.tsx").then((module) => ({
    default: module.SetupPage,
  })),
);
const DomainsPage = lazy(() =>
  import("./domains/domains-page.tsx").then((module) => ({
    default: module.DomainsPage,
  })),
);

function onRequestError(error: unknown) {
  if (
    (error instanceof ORPCError || error instanceof AuthError) &&
    error.status === 401
  )
    expireSession();
}
const queryClient = new QueryClient({
  queryCache: new QueryCache({ onError: onRequestError }),
  mutationCache: new MutationCache({ onError: onRequestError }),
  defaultOptions: {
    queries: { retry: false, staleTime: 30_000, refetchOnWindowFocus: true },
  },
});

function PageLoading() {
  return <div className="page-loading" aria-busy="true" />;
}
function Lazy({ children }: { children: ReactNode }) {
  return <Suspense fallback={<PageLoading />}>{children}</Suspense>;
}

/** Frame for the administration pages and the Contacts placeholder. */
function AdminShell({
  product = "admin",
  signedIn = true,
  children,
}: {
  product?: Product;
  signedIn?: boolean;
  children: ReactNode;
}) {
  const path = useRouterState({ select: (state) => state.location.pathname });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [label, setLabel] = useState(
    () => localStorage.getItem("opensuite-label") || "My workspace",
  );
  const [draft, setDraft] = useState(label);
  const [error, setError] = useState("");
  const [toastOpen, setToastOpen] = useState(false);
  const openSettings = useCallback(() => {
    setDraft(label);
    setError("");
    setSettingsOpen(true);
  }, [label]);
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
  const links = [
    { to: "/status", label: "System status", icon: "status" },
    { to: "/setup", label: "Setup wizard", icon: "sparkle" },
    { to: "/domains", label: "Domains", icon: "globe" },
  ] as const;
  return (
    <ToastProvider>
      <AppShell
        product={product}
        signedIn={signedIn}
        sidebar={
          product === "admin" && (
            <>
              <p className="shell-nav-heading">Workspace</p>
              <p className="admin-workspace-name">{label}</p>
              <p className="shell-nav-heading">Administration</p>
              {links.map((link) => (
                <SidebarLink
                  key={link.to}
                  to={link.to}
                  icon={link.icon}
                  label={link.label}
                  active={
                    path === link.to || (link.to === "/status" && path === "/")
                  }
                />
              ))}
              <SidebarItem
                icon="settings"
                label="Workspace settings"
                onClick={openSettings}
                aria-keyshortcuts="S"
              />
            </>
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
      <Toast
        open={toastOpen}
        onOpenChange={setToastOpen}
        message="Workspace label saved on this device"
      />
    </ToastProvider>
  );
}

function StatusPage() {
  const health = useQuery({
    queryKey: ["health"],
    queryFn: getHealth,
    refetchInterval: 30_000,
  });
  const readiness = useQuery({
    queryKey: ["readiness"],
    queryFn: getReadiness,
    refetchInterval: 30_000,
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
            A live view of your Esuno API and its dependencies.
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
          <Link to="/status">View system status</Link>
        </Button>
      </section>
    </div>
  );
}

const rootRoute = createRootRoute({ component: Outlet });
const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: () => (
    <AdminShell signedIn={false}>
      <StatusPage />
    </AdminShell>
  ),
});
const statusRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/status",
  component: () => (
    <AdminShell signedIn={false}>
      <StatusPage />
    </AdminShell>
  ),
});
const handoffRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/auth/handoff",
  component: HandoffPage,
});
const callbackRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/auth/callback",
  component: CallbackPage,
});
const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  component: LoginPage,
});
const mailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/mail",
  component: () => (
    <Protected>
      <MailPage />
    </Protected>
  ),
});
const calendarRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/calendar",
  component: () => (
    <Protected>
      <Lazy>
        <CalendarPage />
      </Lazy>
    </Protected>
  ),
});
const contactsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/contacts",
  component: () => (
    <Protected>
      <AdminShell product="contacts">
        <ProductPlaceholder name="Contacts" />
      </AdminShell>
    </Protected>
  ),
});
const driveRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/drive",
  component: () => (
    <Protected>
      <Lazy>
        <DrivePage />
      </Lazy>
    </Protected>
  ),
});
const passRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/pass",
  component: () => (
    <Protected>
      <Lazy>
        <PassPage page="home" />
      </Lazy>
    </Protected>
  ),
});
const passGeneratorRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/pass/generator",
  component: () => (
    <Protected>
      <Lazy>
        <PassPage page="generator" />
      </Lazy>
    </Protected>
  ),
});
const passClientsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/pass/clients",
  component: () => (
    <Protected>
      <Lazy>
        <PassPage page="clients" />
      </Lazy>
    </Protected>
  ),
});
const domainsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/domains",
  component: () => (
    <Protected>
      <AdminShell>
        <Lazy>
          <DomainsPage />
        </Lazy>
      </AdminShell>
    </Protected>
  ),
});
const setupRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/setup",
  component: () => (
    <Protected>
      <AdminShell>
        <Lazy>
          <SetupPage />
        </Lazy>
      </AdminShell>
    </Protected>
  ),
});
const rewrite = rewriteFor(layout);
const router = createRouter({
  ...(rewrite === undefined ? {} : { rewrite }),
  routeTree: rootRoute.addChildren([
    indexRoute,
    statusRoute,
    handoffRoute,
    callbackRoute,
    loginRoute,
    mailRoute,
    calendarRoute,
    contactsRoute,
    driveRoute,
    passRoute,
    passGeneratorRoute,
    passClientsRoute,
    domainsRoute,
    setupRoute,
  ]),
});
window.addEventListener("opensuite-session-expired", () => {
  void queryClient.cancelQueries().then(() => {
    queryClient.clear();
    // Sibling origins sign in again through the sign-in origin.
    if (layout.split && layout.host !== "mail" && startHandoff())
      return undefined;
    return router.navigate({ to: "/login" });
  });
});
declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
const root = document.getElementById("root");
if (!root) throw new Error("Root element missing");
// A move to another origin is already under way; do not start this one.
if (moved === null || !/^https?:/.test(moved))
  createRoot(root).render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
