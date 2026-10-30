import * as React from "react";
import { AliasesPage } from "../aliases/aliases-page.tsx";
import { activeLayout } from "../origins.ts";
import { AppShell, SidebarLink } from "../shell/app-shell.tsx";
import { Home } from "./vault-home.tsx";
import { Generator } from "./vault-generator.tsx";
import { Clients } from "./vault-clients.tsx";
// oxlint-disable-next-line import/no-unassigned-import
import "./vault.css";

type Page = "home" | "generator" | "clients" | "aliases";

export function VaultPage({ page }: { page: Page }) {
  const origin = activeLayout().origins.vault;
  return (
    <AppShell
      product="vault"
      productLabel="Esuno Vault"
      sidebar={
        <>
          <p className="shell-nav-heading">Vault</p>
          <SidebarLink
            to="/vault"
            icon="vault"
            label="Overview"
            active={page === "home"}
          />
          <SidebarLink
            to="/vault/generator"
            icon="sparkle"
            label="Generator"
            active={page === "generator"}
          />
          <SidebarLink
            to="/vault/clients"
            icon="settings"
            label="Apps and extensions"
            active={page === "clients"}
          />
          <SidebarLink
            to="/vault/aliases"
            icon="mail"
            label="Aliases"
            active={page === "aliases"}
          />
        </>
      }
    >
      {page === "home" ? (
        <Home origin={origin} />
      ) : page === "generator" ? (
        <Generator />
      ) : page === "clients" ? (
        <Clients origin={origin} />
      ) : (
        <AliasesPage />
      )}
    </AppShell>
  );
}
