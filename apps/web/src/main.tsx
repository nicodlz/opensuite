import { AddressesPage } from "./addresses/page.tsx";
import * as React from "react";
import {
  QueryClient,
  QueryCache,
  MutationCache,
  QueryClientProvider,
} from "@tanstack/react-query";
import {
  Outlet,
  RouterProvider,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { lazy, Suspense, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

import { ORPCError } from "@orpc/client";
import { AuthError } from "./auth/client.ts";
import { LoginPage, Protected, expireSession } from "./auth/components.tsx";
import { CallbackPage, HandoffPage, startHandoff } from "./auth/handoff.tsx";
import { activeLayout, redirectFor, rewriteFor } from "./origins.ts";
import { MailPage } from "./mail/mail-page.tsx";
import { BillingSettings } from "./billing/settings.tsx";
import { SubscribePage, WelcomePage } from "./billing/public.tsx";
import { ProductPlaceholder } from "./shell/admin-pages.tsx";
import { AdminShell, StatusScreen } from "./shell/admin-shell.tsx";
import { PageLoading } from "./shell/app-shell.tsx";
import { useDocumentTitle } from "./ui/document-title.ts";
import { ToastProvider } from "./ui/toast.tsx";

// The bootstrap has already resolved the origin and selected app metadata.
const layout = activeLayout();
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
const VaultPage = lazy(() =>
  import("./vault/vault-page.tsx").then((module) => ({
    default: module.VaultPage,
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

function Lazy({ children }: { children: ReactNode }) {
  return <Suspense fallback={<PageLoading />}>{children}</Suspense>;
}
/** Browser tab title for routes that have no application shell. */
function Titled({ title, children }: { title: string; children: ReactNode }) {
  useDocumentTitle(`${title} · Esuno`);
  return children;
}

const rootRoute = createRootRoute({ component: Outlet });
const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: () => <StatusScreen home />,
});
const statusRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/status",
  component: () => <StatusScreen home={false} />,
});
const handoffRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/auth/handoff",
  component: () => (
    <Titled title="Signing in">
      <HandoffPage />
    </Titled>
  ),
});
const callbackRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/auth/callback",
  component: () => (
    <Titled title="Signing in">
      <CallbackPage />
    </Titled>
  ),
});
const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  component: () => (
    <Titled title="Sign in">
      <LoginPage />
    </Titled>
  ),
});
const addressesSettingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings/addresses",
  component: () => (
    <Protected>
      <AddressesPage />
    </Protected>
  ),
});
const billingSettingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings/billing",
  component: () => (
    <Protected>
      <BillingSettings />
    </Protected>
  ),
});
const subscribeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/subscribe",
  component: () => (
    <Titled title="Choose a plan">
      <SubscribePage />
    </Titled>
  ),
});
const welcomeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/welcome",
  component: () => (
    <Titled title="Welcome">
      <WelcomePage />
    </Titled>
  ),
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
const vaultRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/vault",
  component: () => (
    <Protected>
      <Lazy>
        <VaultPage page="home" />
      </Lazy>
    </Protected>
  ),
});
const vaultGeneratorRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/vault/generator",
  component: () => (
    <Protected>
      <Lazy>
        <VaultPage page="generator" />
      </Lazy>
    </Protected>
  ),
});
const vaultClientsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/vault/clients",
  component: () => (
    <Protected>
      <Lazy>
        <VaultPage page="clients" />
      </Lazy>
    </Protected>
  ),
});
const vaultAliasesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/vault/aliases",
  component: () => (
    <Protected>
      <Lazy>
        <VaultPage page="aliases" />
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
    billingSettingsRoute,
    addressesSettingsRoute,
    subscribeRoute,
    welcomeRoute,
    mailRoute,
    calendarRoute,
    contactsRoute,
    driveRoute,
    vaultRoute,
    vaultGeneratorRoute,
    vaultClientsRoute,
    vaultAliasesRoute,
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
      <ToastProvider>
        <RouterProvider router={router} />
      </ToastProvider>
    </QueryClientProvider>,
  );
