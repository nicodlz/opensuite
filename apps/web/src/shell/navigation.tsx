import * as React from "react";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { Icon, type IconName } from "../ui/icons.tsx";
import { activeLayout, hubHref, isExternal, productHref } from "../origins.ts";

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
  {
    id: "contacts",
    label: "Contacts",
    icon: "contacts",
    mark: "/contacts-mark.svg",
  },
  { id: "vault", label: "Vault", icon: "vault", mark: "/vault-mark.svg" },
  {
    id: "drive",
    label: "Drive",
    icon: "drive",
    mark: "/drive-mark.svg",
  },
];

export function productName(product: Product) {
  return (
    products.find((item) => item.id === product)?.label ?? "Administration"
  );
}

/** Tab title: "Page · Esuno Product", or "Page · Esuno" for administration. */
export function shellTitle(product: Product, page?: string) {
  const app = product === "admin" ? "Esuno" : `Esuno ${productName(product)}`;
  return page ? `${page} · ${app}` : app;
}

/**
 * Route link on this origin, plain link to another application origin. Only
 * an exact path match counts as the current page; the caller sets the style.
 */
export function AppLink({
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
    <Link
      to={href}
      activeOptions={{ exact: true, includeSearch: false }}
      activeProps={{}}
      {...props}
    >
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

function ProductIcon({
  item,
  size,
}: {
  item: (typeof products)[number];
  size?: number;
}) {
  return item.mark ? (
    <img className="product-mark" src={item.mark} alt="" />
  ) : (
    <Icon name={item.icon} {...(size === undefined ? {} : { size })} />
  );
}

/** Product switcher shown on wide screens. */
export function ProductRail({
  product,
  inert,
}: {
  product: Product;
  inert: boolean;
}) {
  const current = (id: Product) => (product === id ? "page" : undefined);
  return (
    <nav className="shell-rail" aria-label="Products" inert={inert}>
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
          aria-current={current(item.id)}
        >
          <span className="shell-rail-icon">
            <ProductIcon item={item} size={20} />
          </span>
          <span>{item.label}</span>
        </AppLink>
      ))}
      <AppLink
        href={hrefOf("admin")}
        className={`shell-rail-link shell-rail-bottom ${product === "admin" ? "active" : ""}`}
        aria-current={current("admin")}
      >
        <span className="shell-rail-icon">
          <Icon name="settings" size={20} />
        </span>
        <span>Admin</span>
      </AppLink>
    </nav>
  );
}

/** Product switcher at the bottom of the mobile navigation drawer. */
export function MobileProducts({ product }: { product: Product }) {
  return (
    <nav className="shell-mobile-products" aria-label="Switch product">
      {products.map((item) => (
        <AppLink
          key={item.id}
          href={hrefOf(item.id)}
          aria-current={product === item.id ? "page" : undefined}
        >
          <ProductIcon item={item} />
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
  );
}
