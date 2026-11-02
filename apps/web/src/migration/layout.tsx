import * as React from "react";
import type { ReactNode } from "react";
import { AppShell } from "../shell/app-shell.tsx";
import { SettingsNav } from "../shell/settings-nav.tsx";
// Vite injects the stylesheet.
// oxlint-disable-next-line import/no-unassigned-import
import "./migration.css";

/** Workspace settings frame shared by the migration pages. */
export function MigrationLayout({
  title,
  heading,
  subtitle,
  actions,
  children,
}: {
  title: string;
  heading: string;
  subtitle: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <AppShell
      product="mail"
      title={title}
      sidebar={<SettingsNav current="/settings/migration" />}
    >
      <div className="content-wrap migration-page">
        <div className="page-breadcrumb">
          WORKSPACE <span>/</span> SETTINGS <span>/</span> MIGRATION
        </div>
        <div className="page-header">
          <div>
            <p className="eyebrow">WORKSPACE SETTINGS</p>
            <h1>{heading}</h1>
            <p className="page-subtitle">{subtitle}</p>
          </div>
          {actions}
        </div>
        {children}
      </div>
    </AppShell>
  );
}
