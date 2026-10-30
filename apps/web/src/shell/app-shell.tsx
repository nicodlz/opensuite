import * as React from "react";
import { themeChoices } from "@opensuite/design-tokens";
import { Link } from "@tanstack/react-router";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { AccountMenu } from "../auth/components.tsx";
import { Button } from "../ui/button.tsx";
import {
  DropdownContent,
  DropdownItemIndicator,
  DropdownMenu,
  DropdownRadioGroup,
  DropdownRadioItem,
  DropdownTrigger,
} from "../ui/dropdown-menu.tsx";
import { Icon, type IconName } from "../ui/icons.tsx";
import { activeLayout, hubHref, isExternal, productHref } from "../origins.ts";
import { setTheme, useTheme } from "./theme.ts";

export type Product =
  "mail" | "calendar" | "contacts" | "drive" | "vault" | "admin";

const products: {
  id: Product;
  label: string;
  icon: IconName;
  mark?: string;
}[] = [
  {
    id: "mail",
    label: "Mail",
    icon: "mail",
    mark: "/mail-mark.svg",
  },
  {
    id: "calendar",
    label: "Calendar",
    icon: "calendar",
    mark: "/calendar-mark.svg",
  },
  { id: "contacts", label: "Contacts", icon: "contacts" },
  { id: "vault", label: "Vault", icon: "vault", mark: "/vault-mark.svg" },
  {
    id: "drive",
    label: "Drive",
    icon: "drive",
    mark: "/drive-mark.svg",
  },
];

/** Route link on this origin, plain link to another application origin. */
function AppLink({
  href,
  className,
  children,
  ...aria
}: {
  href: string;
  className?: string;
  children: ReactNode;
  "aria-label"?: string;
  "aria-current"?: "page" | undefined;
}) {
  const props = {
    ...(className === undefined ? {} : { className }),
    ...(aria["aria-label"] === undefined
      ? {}
      : { "aria-label": aria["aria-label"] }),
    ...(aria["aria-current"] === undefined
      ? {}
      : { "aria-current": aria["aria-current"] }),
  };
  if (isExternal(href))
    return (
      <a href={href} {...props}>
        {children}
      </a>
    );
  return (
    <Link to={href} {...props}>
      {children}
    </Link>
  );
}
const hrefOf = (product: Product) =>
  product === "admin" || product === "contacts" || product === "vault"
    ? hubHref(
        activeLayout(),
        product === "admin"
          ? "/status"
          : product === "vault"
            ? "/vault"
            : "/contacts",
      )
    : productHref(activeLayout(), product);

function AppearanceItems() {
  const theme = useTheme();
  return (
    <>
      <div className="menu-label">Appearance</div>
      <DropdownRadioGroup value={theme} onValueChange={setTheme}>
        {themeChoices.map((choice) => (
          <DropdownRadioItem key={choice} className="menu-item" value={choice}>
            <span className="menu-indicator">
              <DropdownItemIndicator>✓</DropdownItemIndicator>
            </span>
            {choice === "system"
              ? "Use system theme"
              : `${choice.charAt(0).toUpperCase()}${choice.slice(1)} theme`}
          </DropdownRadioItem>
        ))}
      </DropdownRadioGroup>
    </>
  );
}

function AppearanceMenu() {
  return (
    <DropdownMenu>
      <DropdownTrigger asChild>
        <Button
          variant="ghost"
          size="small"
          className="shell-avatar-button"
          aria-label="Account and appearance menu"
        >
          <Icon name="settings" />
        </Button>
      </DropdownTrigger>
      <DropdownContent>
        <AppearanceItems />
      </DropdownContent>
    </DropdownMenu>
  );
}

export function AppShell({
  product,
  productLabel,
  primaryAction,
  sidebar,
  search,
  actions,
  signedIn = true,
  mainId = "main-content",
  mainClassName,
  children,
}: {
  product: Product;
  productLabel?: string;
  primaryAction?: {
    label: string;
    icon?: IconName;
    shortcut?: string;
    onClick: () => void;
  };
  sidebar?: ReactNode;
  search?: ReactNode;
  actions?: ReactNode;
  signedIn?: boolean;
  mainId?: string;
  mainClassName?: string;
  children: ReactNode;
}) {
  const [navOpen, setNavOpen] = useState(false);
  const sidebarRef = useRef<HTMLElement>(null);
  useEffect(() => {
    // Navigating from the mobile drawer closes it.
    const element = sidebarRef.current;
    function close(event: MouseEvent) {
      if (
        event.target instanceof Element &&
        event.target.closest("a, button[data-nav]")
      )
        setNavOpen(false);
    }
    element?.addEventListener("click", close);
    return () => element?.removeEventListener("click", close);
  }, []);
  useEffect(() => {
    if (!navOpen) return undefined;
    function close(event: KeyboardEvent) {
      if (event.key === "Escape") setNavOpen(false);
    }
    document.addEventListener("keydown", close);
    return () => document.removeEventListener("keydown", close);
  }, [navOpen]);
  const label =
    productLabel ??
    products.find((item) => item.id === product)?.label ??
    "Administration";
  return (
    <div className={`shell ${navOpen ? "nav-open" : ""}`}>
      <a href={`#${mainId}`} className="skip-link">
        Skip to content
      </a>
      <nav className="shell-rail" aria-label="Products">
        <AppLink
          href={hrefOf("mail")}
          className="shell-logo"
          aria-label="Esuno home"
        >
          <img src="/mark.svg" alt="" />
        </AppLink>
        {products.map((item) => (
          <AppLink
            key={item.id}
            href={hrefOf(item.id)}
            className={`shell-rail-link ${product === item.id ? "active" : ""}`}
            aria-current={product === item.id ? "page" : undefined}
          >
            <span className="shell-rail-icon">
              {item.mark ? (
                <img className="product-mark" src={item.mark} alt="" />
              ) : (
                <Icon name={item.icon} size={20} />
              )}
            </span>
            <span>{item.label}</span>
          </AppLink>
        ))}
        <AppLink
          href={hrefOf("admin")}
          className={`shell-rail-link shell-rail-bottom ${product === "admin" ? "active" : ""}`}
          aria-current={product === "admin" ? "page" : undefined}
        >
          <span className="shell-rail-icon">
            <Icon name="settings" size={20} />
          </span>
          <span>Admin</span>
        </AppLink>
      </nav>
      <aside className="shell-sidebar" ref={sidebarRef}>
        <div className="shell-sidebar-head">
          <span className="shell-product-name">{label}</span>
          <button
            type="button"
            className="shell-drawer-close"
            aria-label="Close navigation"
            onClick={() => setNavOpen(false)}
          >
            <Icon name="close" />
          </button>
        </div>
        {primaryAction && (
          <Button
            className="shell-primary"
            onClick={() => {
              setNavOpen(false);
              primaryAction.onClick();
            }}
          >
            <Icon name={primaryAction.icon ?? "plus"} />
            <span>{primaryAction.label}</span>
            {primaryAction.shortcut && <kbd>{primaryAction.shortcut}</kbd>}
          </Button>
        )}
        <div className="shell-sidebar-scroll">{sidebar}</div>
        <nav className="shell-mobile-products" aria-label="Switch product">
          {products.map((item) => (
            <AppLink
              key={item.id}
              href={hrefOf(item.id)}
              aria-current={product === item.id ? "page" : undefined}
            >
              {item.mark ? (
                <img className="product-mark" src={item.mark} alt="" />
              ) : (
                <Icon name={item.icon} />
              )}
              {item.label}
            </AppLink>
          ))}
          <AppLink
            href={hrefOf("admin")}
            aria-current={product === "admin" ? "page" : undefined}
          >
            <Icon name="settings" />
            Admin
          </AppLink>
        </nav>
      </aside>
      <button
        type="button"
        className="shell-scrim"
        aria-label="Close navigation"
        tabIndex={-1}
        onClick={() => setNavOpen(false)}
      />
      <div className="shell-body">
        <header className="shell-topbar">
          <button
            type="button"
            className="shell-menu-button"
            aria-label="Open navigation"
            aria-expanded={navOpen}
            onClick={() => setNavOpen(true)}
          >
            <Icon name="menu" size={20} />
          </button>
          <div className="shell-search">{search}</div>
          <div className="shell-actions">
            {actions}
            {signedIn ? (
              <AccountMenu>
                <AppearanceItems />
              </AccountMenu>
            ) : (
              <AppearanceMenu />
            )}
          </div>
        </header>
        {primaryAction && (
          <button
            type="button"
            className="shell-fab"
            aria-label={primaryAction.label}
            onClick={primaryAction.onClick}
          >
            <Icon name={primaryAction.icon ?? "plus"} size={22} />
          </button>
        )}
        <main
          id={mainId}
          tabIndex={-1}
          className={`shell-main ${mainClassName ?? ""}`}
        >
          {children}
        </main>
      </div>
    </div>
  );
}

/** Sidebar link to another route. */
export function SidebarLink({
  to,
  icon,
  label,
  active,
}: {
  to: string;
  icon: IconName;
  label: string;
  active?: boolean;
}) {
  return (
    <Link
      to={to}
      className={`shell-nav-item ${active ? "active" : ""}`}
      aria-current={active ? "page" : undefined}
    >
      <Icon name={icon} />
      <span className="shell-nav-label">{label}</span>
    </Link>
  );
}

/** Sidebar navigation entry shared by product sidebars. */
export function SidebarItem({
  icon,
  label,
  count,
  active,
  onClick,
  color,
  ...props
}: Omit<React.ComponentProps<"button">, "color"> & {
  icon?: IconName;
  label: string;
  count?: number;
  active?: boolean;
  color?: string;
}) {
  return (
    <button
      type="button"
      data-nav
      className={`shell-nav-item ${active ? "active" : ""}`}
      aria-current={active ? "page" : undefined}
      onClick={onClick}
      {...props}
    >
      {color ? (
        <span
          className="shell-nav-swatch"
          style={{ background: color }}
          aria-hidden="true"
        />
      ) : (
        icon && <Icon name={icon} />
      )}
      <span className="shell-nav-label">{label}</span>
      {count !== undefined && count > 0 && (
        <span className="shell-nav-count">{count}</span>
      )}
    </button>
  );
}
