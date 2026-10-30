import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { z } from "zod";
import { activeLayout } from "../origins.ts";
import { Button } from "../ui/button.tsx";
import { auth } from "./client.ts";

const pendingKey = "opensuite-handoff";
const attemptsKey = "opensuite-handoff-attempts";
export const returnKey = "opensuite-sign-in-return";
const statePattern = /^[A-Za-z0-9_-]{43}$/;

function randomState() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}
const safePath = (value: unknown) =>
  typeof value === "string" && value.startsWith("/") && !value.startsWith("//")
    ? value
    : "/";

/**
 * Sends this sibling origin through the sign-in origin. Returns false when
 * repeated attempts failed, so the caller can show an error instead of looping.
 */
export function startHandoff() {
  const layout = activeLayout();
  const now = Date.now();
  let stored: unknown = [];
  try {
    stored = JSON.parse(sessionStorage.getItem(attemptsKey) ?? "[]");
  } catch {
    stored = [];
  }
  const recent = z
    .array(z.number())
    .catch([])
    .parse(stored)
    .filter((time) => now - time < 60_000);
  if (recent.length >= 3) return false;
  sessionStorage.setItem(attemptsKey, JSON.stringify([...recent, now]));
  const state = randomState();
  sessionStorage.setItem(
    pendingKey,
    JSON.stringify({
      state,
      // The callback page itself is never a page to come back to.
      path: window.location.pathname.startsWith("/auth/")
        ? "/"
        : window.location.pathname + window.location.search,
      at: now,
    }),
  );
  const url = new URL("/auth/handoff", layout.hub);
  url.searchParams.set("to", window.location.origin);
  url.searchParams.set("state", state);
  window.location.assign(url.toString());
  return true;
}

function HandoffMessage({
  title,
  children,
}: {
  title: string;
  children?: React.ReactNode;
}) {
  return (
    <main className="auth-page">
      <div className="auth-card" role={children ? "alert" : "status"}>
        <h1>{title}</h1>
        {children}
      </div>
    </main>
  );
}

/** Sign-in origin: issues a token for a listed sibling origin. */
export function HandoffPage() {
  const layout = activeLayout();
  const params = new URLSearchParams(window.location.search);
  const target = params.get("to") ?? "";
  const state = params.get("state") ?? "";
  const allowed =
    layout.split &&
    layout.host === "mail" &&
    target !== layout.hub &&
    Object.values(layout.origins).includes(target) &&
    statePattern.test(state);
  const session = useQuery({
    queryKey: ["auth", "session"],
    queryFn: () => auth.session(),
    retry: false,
    enabled: allowed,
  });
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!allowed || !session.isSuccess) return;
    if (session.data === null) {
      sessionStorage.setItem(
        returnKey,
        window.location.pathname + window.location.search,
      );
      window.location.replace("/login");
      return;
    }
    auth
      .handoff(target)
      .then((token) => {
        const destination = new URL("/auth/callback", target);
        destination.hash = new URLSearchParams({ token, state }).toString();
        window.location.replace(destination.toString());
        return undefined;
      })
      .catch(() => setFailed(true));
  }, [allowed, session.isSuccess, session.data, target, state]);
  if (!allowed || failed || session.isError)
    return (
      <HandoffMessage title="Could not continue">
        <p>This sign-in link is not valid. Open the application again.</p>
        <Button asChild>
          <a href="/">Go to Mail</a>
        </Button>
      </HandoffMessage>
    );
  return <HandoffMessage title="Signing you in…" />;
}

const Pending = z.object({
  state: z.string().regex(statePattern),
  path: z.string(),
  at: z.number(),
});
/** Reads the callback fragment and the pending request without changing them. */
function readCallback() {
  const fragment = new URLSearchParams(window.location.hash.slice(1));
  const token = fragment.get("token") ?? "";
  let stored: unknown = null;
  try {
    stored = JSON.parse(sessionStorage.getItem(pendingKey) ?? "null");
  } catch {
    stored = null;
  }
  const pending = Pending.safeParse(stored);
  return pending.success &&
    pending.data.state === fragment.get("state") &&
    Date.now() - pending.data.at < 5 * 60_000 &&
    token.length >= 16
    ? { token, path: safePath(pending.data.path) }
    : null;
}

/** Sibling origin: redeems the token once, then restores the page. */
export function CallbackPage() {
  const client = useQueryClient();
  const [link] = useState(readCallback);
  const [error, setError] = useState(link === null);
  useEffect(() => {
    // Remove the token from the address bar and history before any request.
    window.history.replaceState(null, "", window.location.pathname);
    sessionStorage.removeItem(pendingKey);
    if (link === null) return;
    auth
      .redeem(link.token)
      .then(async () => {
        sessionStorage.removeItem(attemptsKey);
        await client.invalidateQueries({ queryKey: ["auth", "session"] });
        window.location.replace(link.path);
        return undefined;
      })
      .catch(() => setError(true));
  }, [client, link]);
  if (error)
    return (
      <HandoffMessage title="Sign-in link expired">
        <p>The link was already used or has expired.</p>
        <Button onClick={() => startHandoff()}>Try again</Button>
      </HandoffMessage>
    );
  return <HandoffMessage title="Signing you in…" />;
}
