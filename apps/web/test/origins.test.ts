// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  hubHref,
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
    expect(redirectFor(sibling, "/setup", "?step=2")).toBe(
      `${mail}/setup?step=2`,
    );
    expect(redirectFor(sibling, "/mail", "")).toBe(`${mail}/`);
    expect(redirectFor(sibling, "/auth/callback", "")).toBeNull();
    expect(redirectFor(sibling, "/", "?folder=abc")).toBeNull();
  });
});

describe("origin map loading", () => {
  beforeEach(() => localStorage.clear());
  const answer = (body: unknown, status = 200) =>
    (() =>
      Promise.resolve(
        new Response(JSON.stringify(body), { status }),
      )) as typeof fetch;
  const offline = (() =>
    Promise.reject(new TypeError("offline"))) as typeof fetch;

  it("always prefers the current configuration and stores it", async () => {
    localStorage.setItem("opensuite-origins", JSON.stringify({ mail }));
    expect(await loadOrigins(calendar, answer(origins))).toEqual(origins);
    expect(JSON.parse(localStorage.getItem("opensuite-origins") ?? "")).toEqual(
      origins,
    );
  });
  it("falls back to a cached copy only if it lists this origin", async () => {
    localStorage.setItem("opensuite-origins", JSON.stringify(origins));
    expect(await loadOrigins(drive, offline)).toEqual(origins);
    expect(await loadOrigins("https://other.example.test", offline)).toEqual(
      {},
    );
    expect(await loadOrigins(drive, answer({ error: true }, 503))).toEqual(
      origins,
    );
  });
  it("ignores an invalid cache or response", async () => {
    localStorage.setItem("opensuite-origins", "{not json");
    expect(await loadOrigins(drive, offline)).toEqual({});
    localStorage.setItem("opensuite-origins", JSON.stringify({ mail: 3 }));
    expect(await loadOrigins(drive, offline)).toEqual({});
    expect(await loadOrigins(drive, answer({ drive: "not a url" }))).toEqual(
      {},
    );
  });
});
