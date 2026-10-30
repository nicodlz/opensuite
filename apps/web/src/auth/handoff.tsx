import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
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
  const recent = (
    JSON.parse(sessionStorage.getItem(attemptsKey) ?? "[]") as unknown[]
  ).filter(
    (time): time is number => typeof time === "number" && now - time < 60_000,
  );
  if (recent.length >= 3) return false;
  sessionStorage.setItem(attemptsKey, JSON.stringify([...recent, now]));
  const state = randomState();
  sessionStorage.setItem(
    pendingKey,
    JSON.stringify({
      state,
      path: window.location.pathname + window.location.search,
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

/** Sibling origin: redeems the token once, then restores the page. */
export function CallbackPage() {
  const client = useQueryClient();
  const [error, setError] = useState(false);
  useEffect(() => {
    // Remove the token from the address bar and history before any request.
    const fragment = new URLSearchParams(window.location.hash.slice(1));
    window.history.replaceState(null, "", window.location.pathname);
    const token = fragment.get("token") ?? "";
    const state = fragment.get("state") ?? "";
    let pending: unknown = null;
    try {
      pending = JSON.parse(sessionStorage.getItem(pendingKey) ?? "null");
    } catch {
      pending = null;
    }
    sessionStorage.removeItem(pendingKey);
    const expected =
      typeof pending === "object" && pending !== null ? pending : {};
    const valid =
      "state" in expected &&
      expected.state === state &&
      statePattern.test(state) &&
      "at" in expected &&
      typeof expected.at === "number" &&
      Date.now() - expected.at < 5 * 60_000 &&
      token.length >= 16;
    if (!valid) {
      setError(true);
      return;
    }
    const path = "path" in expected ? safePath(expected.path) : "/";
    auth
      .redeem(token)
      .then(async () => {
        sessionStorage.removeItem(attemptsKey);
        await client.invalidateQueries({ queryKey: ["auth", "session"] });
        window.location.replace(path);
        return undefined;
      })
      .catch(() => setError(true));
  }, [client]);
  if (error)
    return (
      <HandoffMessage title="Sign-in link expired">
        <p>The link was already used or has expired.</p>
        <Button onClick={() => startHandoff()}>Try again</Button>
      </HandoffMessage>
    );
  return <HandoffMessage title="Signing you in…" />;
}
