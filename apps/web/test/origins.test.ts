// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  hubHref,
  installProduct,
  loadOrigins,
  productHref,
  redirectFor,
  resolveLayout,
  rewriteFor,
} from "../src/origins.ts";

const mail = "https://mail.example.test";
const drive = "https://drive.example.test";
const calendar = "https://calendar.example.test";
const origins = { mail, drive, calendar };

describe("origin layout", () => {
  it("keeps path routing on a single origin", () => {
    const layout = resolveLayout({ mail }, mail);
    expect(layout.split).toBe(false);
    expect(productHref(layout, "drive")).toBe("/drive");
    expect(redirectFor(layout, "/drive", "?q=1")).toBeNull();
    expect(rewriteFor(layout)).toBeUndefined();
    expect(resolveLayout({}, "http://localhost:5173").split).toBe(false);
    expect(
      resolveLayout({ mail, vault: "https://vault.example.test" }, mail).split,
    ).toBe(false);
  });
  it("serves each application at the root of its own origin", () => {
    const layout = resolveLayout(origins, calendar);
    expect(layout).toMatchObject({ split: true, host: "calendar", hub: mail });
    expect(productHref(layout, "calendar")).toBe("/");
    expect(productHref(layout, "mail")).toBe(`${mail}/`);
    expect(productHref(layout, "drive")).toBe(`${drive}/`);
    expect(hubHref(layout, "/status")).toBe(`${mail}/status`);
    expect(hubHref(resolveLayout(origins, mail), "/status")).toBe("/status");
    const rewrite = rewriteFor(layout);
    expect(rewrite?.input({ url: new URL(`${calendar}/`) })?.pathname).toBe(
      "/calendar",
    );
    expect(
      rewrite?.output({ url: new URL(`${calendar}/calendar`) })?.pathname,
    ).toBe("/");
    expect(rewrite?.input({ url: new URL(`${calendar}/auth/callback`) })).toBe(
      undefined,
    );
  });
  it("moves old URLs with their path, query and fragment", () => {
    const hub = resolveLayout(origins, mail);
    expect(redirectFor(hub, "/drive", "?folder=abc", "#x")).toBe(
      `${drive}/?folder=abc#x`,
    );
    expect(redirectFor(hub, "/calendar/2026/10", "?view=week")).toBe(
      `${calendar}/2026/10?view=week`,
    );
    expect(redirectFor(hub, "/mail", "?thread=t1")).toBe("/?thread=t1");
    expect(redirectFor(hub, "/status", "")).toBeNull();
    expect(redirectFor(hub, "/drive-notes", "")).toBeNull();
    const sibling = resolveLayout(origins, drive);
    expect(redirectFor(sibling, "/login", "")).toBe(`${mail}/login`);
    expect(redirectFor(sibling, "/vault/generator", "?x=1")).toBe(
      `${mail}/vault/generator?x=1`,
    );
    expect(redirectFor(sibling, "/setup", "?step=2")).toBe(
      `${mail}/setup?step=2`,
    );
    expect(redirectFor(sibling, "/mail", "")).toBe(`${mail}/`);
    expect(redirectFor(sibling, "/auth/callback", "")).toBeNull();
    expect(redirectFor(sibling, "/", "?folder=abc")).toBeNull();
    // Doubled slashes stay paths on this origin instead of naming a host.
    expect(redirectFor(sibling, "/drive//attacker.example", "")).toBe(
      "/attacker.example",
    );
    expect(redirectFor(hub, "//drive//x", "")).toBe(`${drive}/x`);
    expect(redirectFor(sibling, "//login", "")).toBe(`${mail}/login`);
  });
});

const answer =
  (body: unknown, status = 200): typeof fetch =>
  () =>
    Promise.resolve(new Response(JSON.stringify(body), { status }));
const offline: typeof fetch = () => Promise.reject(new TypeError("offline"));

describe("installation product", () => {
  it("uses the configured product on each split origin and Mail otherwise", () => {
    expect(installProduct(resolveLayout(origins, mail))).toBe("mail");
    expect(installProduct(resolveLayout(origins, drive))).toBe("drive");
    expect(installProduct(resolveLayout(origins, calendar))).toBe("calendar");
    expect(installProduct(resolveLayout({ mail }, mail))).toBe("mail");
    expect(installProduct(resolveLayout({}, drive))).toBe("mail");
    expect(
      installProduct(resolveLayout(origins, "https://unknown.example.test")),
    ).toBe("mail");
    expect(installProduct(resolveLayout({ mail, drive: mail }, mail))).toBe(
      "mail",
    );
  });
});

describe("origin map loading", () => {
  beforeEach(() => localStorage.clear());
  it("uses the current configuration", async () => {
    expect(await loadOrigins(answer(origins))).toEqual(origins);
  });
  it("never falls back to a remembered map", async () => {
    // A map remembered by an older release must not drive redirects.
    localStorage.setItem("opensuite-origins", JSON.stringify(origins));
    expect(await loadOrigins(offline)).toEqual({});
    expect(await loadOrigins(answer({ error: true }, 503))).toEqual({});
    expect(await loadOrigins(answer({ drive: "not a url" }))).toEqual({});
    expect(await loadOrigins(answer({ vault: "javascript:alert(1)" }))).toEqual(
      {},
    );
    expect(
      await loadOrigins(answer({ vault: "https://vault.example.test/path" })),
    ).toEqual({});
  });
  it("keeps the app on this origin without a map", () => {
    const layout = resolveLayout({}, drive);
    expect(layout.split).toBe(false);
    expect(redirectFor(layout, "/mail", "")).toBeNull();
  });
});
