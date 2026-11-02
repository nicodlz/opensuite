import { MailNotificationOffer, NotificationPrompt } from "../push/prompt.tsx";
import { PushSettings } from "../push/settings.tsx";
import * as React from "react";
import type { PushProduct } from "@opensuite/contracts";
import { themeChoices } from "@opensuite/design-tokens";
import { Link } from "@tanstack/react-router";
import { useState, type ReactNode, type RefObject } from "react";
import { AccountMenu } from "../auth/components.tsx";
import { Button } from "../ui/button.tsx";
import { useDocumentTitle } from "../ui/document-title.ts";
import {
  DropdownContent,
  DropdownItemIndicator,
  DropdownItem,
  DropdownMenu,
  DropdownRadioGroup,
  DropdownRadioItem,
  DropdownTrigger,
} from "../ui/dropdown-menu.tsx";
import { Icon, type IconName } from "../ui/icons.tsx";
import { activeLayout, hubHref } from "../origins.ts";
import { useNavigationDrawer } from "./drawer.ts";
import {
  AppLink,
  MobileProducts,
  ProductRail,
  productName,
  shellTitle,
  type Product,
} from "./navigation.tsx";
import { setTheme, useTheme } from "./theme.ts";
import { useVisualViewport } from "./viewport.ts";

export type { Product } from "./navigation.tsx";

type PrimaryAction = {
  label: string;
  icon?: IconName;
  shortcut?: string;
  onClick: () => void;
};
type Drawer = { open: boolean; setOpen: (open: boolean) => void };

const pushProductOf = (product: Product): PushProduct | null =>
  product === "mail" || product === "calendar" || product === "drive"
    ? product
    : null;

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

/** Theme menu and sign-in link for visitors without a session. */
function SignedOutActions() {
  return (
    <>
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
      <Button asChild size="small">
        <AppLink href={hubHref(activeLayout(), "/login")}>Sign in</AppLink>
      </Button>
    </>
  );
}

function SignedInActions({ product }: { product: Product }) {
  const [pushOpen, setPushOpen] = useState(false);
  const pushProduct = pushProductOf(product);
  return (
    <>
      {pushProduct && (
        <PushSettings
          product={pushProduct}
          open={pushOpen}
          onOpenChange={setPushOpen}
        />
      )}
      <AccountMenu>
        {pushProduct && (
          <DropdownItem
            className="menu-item"
            onSelect={() => setPushOpen(true)}
          >
            Notification settings
          </DropdownItem>
        )}
        <DropdownItem className="menu-item" asChild>
          <a href={hubHref(activeLayout(), "/settings/addresses")}>Addresses</a>
        </DropdownItem>
        <DropdownItem className="menu-item" asChild>
          <a href={hubHref(activeLayout(), "/settings/billing")}>
            Plan &amp; storage
          </a>
        </DropdownItem>
        <AppearanceItems />
      </AccountMenu>
    </>
  );
}

/** Sidebar on wide screens, modal navigation drawer on narrow ones. */
function ShellSidebar({
  product,
  label,
  primaryAction,
  drawer,
  drawerRef,
  children,
}: {
  product: Product;
  label: string;
  primaryAction: PrimaryAction | undefined;
  drawer: Drawer;
  drawerRef: RefObject<HTMLElement | null>;
  children: ReactNode;
}) {
  const modal = drawer.open
    ? ({
        role: "dialog",
        "aria-modal": true,
        "aria-label": `${label} navigation`,
      } as const)
    : {};
  return (
    <aside className="shell-sidebar" ref={drawerRef} {...modal}>
      <div className="shell-sidebar-head">
        <span className="shell-product-name">{label}</span>
        <button
          type="button"
          className="shell-drawer-close"
          aria-label="Close navigation"
          data-drawer-focus
          onClick={() => drawer.setOpen(false)}
        >
          <Icon name="close" />
        </button>
      </div>
      {primaryAction && (
        <Button
          className="shell-primary"
          onClick={() => {
            drawer.setOpen(false);
            primaryAction.onClick();
          }}
        >
          <Icon name={primaryAction.icon ?? "plus"} />
          <span>{primaryAction.label}</span>
          {primaryAction.shortcut && <kbd>{primaryAction.shortcut}</kbd>}
        </Button>
      )}
      <div className="shell-sidebar-scroll">{children}</div>
      <MobileProducts product={product} />
    </aside>
  );
}

function ShellTopbar({
  product,
  search,
  actions,
  signedIn,
  drawer,
  openerRef,
}: {
  product: Product;
  search: ReactNode;
  actions: ReactNode;
  signedIn: boolean;
  drawer: Drawer;
  openerRef: RefObject<HTMLButtonElement | null>;
}) {
  return (
    <header className="shell-topbar">
      <button
        ref={openerRef}
        type="button"
        className="shell-menu-button"
        aria-label="Open navigation"
        aria-expanded={drawer.open}
        onClick={() => drawer.setOpen(true)}
      >
        <Icon name="menu" size={20} />
      </button>
      <div className="shell-search">{search}</div>
      <div className="shell-actions">
        {actions}
        {signedIn ? (
          <SignedInActions product={product} />
        ) : (
          <SignedOutActions />
        )}
      </div>
    </header>
  );
}

/** Push suggestions for the signed-in products that send notifications. */
function ShellPrompts({ product }: { product: Product }) {
  const pushProduct = pushProductOf(product);
  return (
    <>
      {pushProduct && (
        <NotificationPrompt key={pushProduct} product={pushProduct} />
      )}
      {product === "mail" && <MailNotificationOffer />}
    </>
  );
}

/** Tab title, and the visible part of the window for full-screen panels. */
function useFrame(product: Product, title: string | undefined) {
  useDocumentTitle(shellTitle(product, title));
  useVisualViewport();
}

export function AppShell({
  product,
  productLabel,
  title,
  primaryAction,
  sidebar,
  search,
  actions,
  signedIn = true,
  mainId = "main-content",
  mainClassName = "",
  children,
}: {
  product: Product;
  productLabel?: string;
  /** Page name shown before the product in the browser tab. */
  title?: string;
  primaryAction?: PrimaryAction;
  sidebar?: ReactNode;
  search?: ReactNode;
  actions?: ReactNode;
  signedIn?: boolean;
  mainId?: string;
  mainClassName?: string;
  children: ReactNode;
}) {
  const { drawerRef, openerRef, ...drawer } = useNavigationDrawer();
  useFrame(product, title);
  return (
    <div className={`shell ${drawer.open ? "nav-open" : ""}`}>
      <a href={`#${mainId}`} className="skip-link" inert={drawer.open}>
        Skip to content
      </a>
      <ProductRail product={product} inert={drawer.open} />
      <ShellSidebar
        product={product}
        label={productLabel ?? productName(product)}
        primaryAction={primaryAction}
        drawer={drawer}
        drawerRef={drawerRef}
      >
        {sidebar}
      </ShellSidebar>
      <button
        type="button"
        className="shell-scrim"
        aria-label="Close navigation"
        tabIndex={-1}
        onClick={() => drawer.setOpen(false)}
      />
      <div className="shell-body" inert={drawer.open}>
        {signedIn && <ShellPrompts product={product} />}
        <ShellTopbar
          product={product}
          search={search}
          actions={actions}
          signedIn={signedIn}
          drawer={drawer}
          openerRef={openerRef}
        />
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
          className={`shell-main ${mainClassName}`}
        >
          {children}
        </main>
      </div>
    </div>
  );
}

/** Progress bar shown while a page or its session check loads. */
export function PageLoading() {
  return <div className="page-loading" aria-busy="true" />;
}

/** Sidebar link to another route; only an exact path match is current. */
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
      activeOptions={{ exact: true, includeSearch: false }}
      activeProps={{}}
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
