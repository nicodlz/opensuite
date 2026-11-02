import * as React from "react";
import { SidebarLink } from "./app-shell.tsx";

const pages = [
  { to: "/settings/addresses", icon: "mail", label: "Addresses" },
  { to: "/settings/billing", icon: "settings", label: "Plan & storage" },
  { to: "/settings/migration", icon: "upload", label: "Migration" },
] as const;
type SettingsPage = (typeof pages)[number]["to"];

/** Sidebar shared by the workspace settings pages. */
export function SettingsNav({ current }: { current: SettingsPage }) {
  return (
    <>
      <p className="shell-nav-heading">Workspace settings</p>
      {pages.map((page) => (
        <SidebarLink
          key={page.to}
          to={page.to}
          icon={page.icon}
          label={page.label}
          active={page.to === current}
        />
      ))}
    </>
  );
}
