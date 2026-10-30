import {
  ProductOriginsSchema,
  type ProductOrigins,
} from "@opensuite/contracts";

export type AppProduct = "mail" | "drive" | "calendar";
export const productPaths: Record<AppProduct, string> = {
  mail: "/mail",
  drive: "/drive",
  calendar: "/calendar",
};
const products = Object.keys(productPaths) as AppProduct[];
/** Paths that only exist on the sign-in (mail) origin. */
const hubPaths = ["/login", "/status", "/setup", "/domains", "/contacts"];

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
  for (const product of products) {
    const path = productPaths[product];
    if (pathname !== path && !pathname.startsWith(`${path}/`)) continue;
    const rest = pathname.slice(path.length) || "/";
    if (product === layout.host) return `${rest}${tail}`;
    const origin = layout.origins[product];
    return origin === undefined ? null : `${origin}${rest}${tail}`;
  }
  if (
    layout.host !== "mail" &&
    hubPaths.some(
      (path) => pathname === path || pathname.startsWith(`${path}/`),
    )
  )
    return `${layout.hub}${pathname}${tail}`;
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

const cacheKey = "opensuite-origins";
function cachedOrigins(current: string): ProductOrigins | null {
  try {
    const parsed = ProductOriginsSchema.safeParse(
      JSON.parse(localStorage.getItem(cacheKey) ?? "null"),
    );
    // A copy that does not list this origin belongs to another configuration.
    return parsed.success && Object.values(parsed.data).includes(current)
      ? parsed.data
      : null;
  } catch {
    return null;
  }
}
/**
 * Reads the origin map from the API on every start, so a configuration
 * change applies at once. The last good copy is a fallback only when the API
 * cannot answer within two seconds.
 */
export async function loadOrigins(
  current = window.location.origin,
  fetcher: typeof fetch = fetch,
): Promise<ProductOrigins> {
  try {
    const response = await fetcher("/api/origins", {
      credentials: "same-origin",
      cache: "no-store",
      signal: AbortSignal.timeout(2000),
    });
    if (response.ok) {
      const parsed = ProductOriginsSchema.safeParse(await response.json());
      if (parsed.success) {
        localStorage.setItem(cacheKey, JSON.stringify(parsed.data));
        return parsed.data;
      }
    }
  } catch {
    // Fall through to the cached copy.
  }
  return cachedOrigins(current) ?? {};
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
