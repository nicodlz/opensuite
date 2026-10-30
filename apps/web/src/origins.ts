import {
  ProductOriginsSchema,
  type ProductOrigins,
} from "@opensuite/contracts";

export type AppProduct = "mail" | "drive" | "calendar";
const productPaths: Record<AppProduct, string> = {
  mail: "/mail",
  drive: "/drive",
  calendar: "/calendar",
};
const products: AppProduct[] = ["mail", "drive", "calendar"];
/** Paths that only exist on the sign-in (mail) origin. */
const hubPaths = [
  "/login",
  "/status",
  "/setup",
  "/domains",
  "/contacts",
  "/vault",
];

export type OriginLayout = {
  /** True when applications are served from separate origins. */
  split: boolean;
  /** Application served at the root of the current origin. */
  host: AppProduct | null;
  hub: string;
  origins: ProductOrigins;
};

export function resolveLayout(
  origins: ProductOrigins,
  current: string,
): OriginLayout {
  const host = products.find((product) => origins[product] === current) ?? null;
  const split =
    host !== null &&
    products.some(
      (product) =>
        origins[product] !== undefined && origins[product] !== current,
    );
  return {
    split,
    host: split ? host : null,
    hub: split ? (origins.mail ?? current) : current,
    origins,
  };
}

/** Installation metadata follows the app on a split origin, or Mail by default. */
export function installProduct(layout: OriginLayout): AppProduct {
  return layout.host ?? "mail";
}

/** URL of an application: absolute on another origin, a route path otherwise. */
export function productHref(layout: OriginLayout, product: AppProduct) {
  if (!layout.split) return productPaths[product];
  const origin = layout.origins[product];
  if (origin === undefined) return `${layout.hub}${productPaths[product]}`;
  return product === layout.host ? "/" : `${origin}/`;
}
export function hubHref(layout: OriginLayout, path: string) {
  return layout.split && layout.host !== "mail" ? `${layout.hub}${path}` : path;
}
export const isExternal = (href: string) => /^https?:\/\//.test(href);

/**
 * Where an incoming path belongs. Old single-origin URLs and paths of other
 * applications move to the origin that now serves them, keeping the rest of
 * the path, the query and the fragment.
 */
export function redirectFor(
  layout: OriginLayout,
  pathname: string,
  search = "",
  hash = "",
): string | null {
  if (!layout.split || layout.host === null) return null;
  const tail = `${search}${hash}`;
  // "//host" would read as another origin; keep every path on this origin.
  const path = pathname.replace(/^\/{2,}/, "/");
  for (const product of products) {
    const prefix = productPaths[product];
    if (path !== prefix && !path.startsWith(`${prefix}/`)) continue;
    const rest = (path.slice(prefix.length) || "/").replace(/^\/{2,}/, "/");
    if (product === layout.host) return `${rest}${tail}`;
    const origin = layout.origins[product];
    return origin === undefined ? null : `${origin}${rest}${tail}`;
  }
  if (
    layout.host !== "mail" &&
    hubPaths.some(
      (hubPath) => path === hubPath || path.startsWith(`${hubPath}/`),
    )
  )
    return `${layout.hub}${path}${tail}`;
  return null;
}

/** Maps the public root of an application origin to its route and back. */
export function rewriteFor(layout: OriginLayout) {
  const host = layout.host;
  if (!layout.split || host === null) return undefined;
  const path = productPaths[host];
  return {
    input: ({ url }: { url: URL }) => {
      if (url.pathname !== "/") return undefined;
      url.pathname = path;
      return url;
    },
    output: ({ url }: { url: URL }) => {
      if (url.pathname !== path) return undefined;
      url.pathname = "/";
      return url;
    },
  };
}

/**
 * Reads the origin map from the API on every start. Without an answer within
 * two seconds the app stays on this origin with path routing: a remembered
 * map could name a host that no longer belongs to this installation, so it is
 * never used to send users elsewhere.
 */
export async function loadOrigins(
  fetcher: typeof fetch = fetch,
): Promise<ProductOrigins> {
  try {
    const response = await fetcher("/api/origins", {
      credentials: "same-origin",
      cache: "no-store",
      signal: AbortSignal.timeout(2000),
    });
    if (!response.ok) return {};
    const parsed = ProductOriginsSchema.safeParse(await response.json());
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

let active: OriginLayout = {
  split: false,
  host: null,
  hub: window.location.origin,
  origins: {},
};
/** Set once at start-up, before the router renders. */
export function setActiveLayout(layout: OriginLayout) {
  active = layout;
}
export const activeLayout = () => active;
