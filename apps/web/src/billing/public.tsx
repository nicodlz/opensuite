import * as React from "react";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { BillingInterval, PlanId, plans } from "@opensuite/contracts";
import { Button } from "../ui/button.tsx";
import { TextField } from "../ui/text-field.tsx";
import { billing } from "./client.ts";
import { billingError, price } from "./model.ts";
// Vite injects the stylesheet.
// oxlint-disable-next-line import/no-unassigned-import
import "./billing.css";

const docs =
  "https://github.com/nicodlz/opensuite/blob/main/docs/deployment/production.md";
function Frame({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="auth-page">
      <div className="auth-card billing-public">
        <div className="brand">
          <img className="brand-mark" src="/mark.svg" alt="" /> Esuno
        </div>
        <h1>{title}</h1>
        {children}
      </div>
    </main>
  );
}
export function SubscribePage() {
  const params = new URLSearchParams(window.location.search);
  const initialPlan = PlanId.safeParse(params.get("plan"));
  const initialInterval = BillingInterval.safeParse(params.get("interval"));
  const [plan, setPlan] = useState(
    initialPlan.success ? initialPlan.data : "plus",
  );
  const [interval, setInterval] = useState(
    initialInterval.success ? initialInterval.data : "month",
  );
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(
    initialPlan.success && initialInterval.success,
  );
  async function checkout(
    selectedPlan: PlanId,
    selectedInterval: BillingInterval,
  ) {
    setBusy(true);
    setError("");
    try {
      const result = await billing.checkout({
        plan: selectedPlan,
        interval: selectedInterval,
      });
      window.location.assign(result.url);
    } catch (failure) {
      setError(billingError(failure));
      setBusy(false);
    }
  }
  useEffect(() => {
    if (initialPlan.success && initialInterval.success)
      void checkout(initialPlan.data, initialInterval.data);
    // Read the initial URL once; changing the chooser requires an explicit submit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <Frame title="Choose Esuno Cloud">
      {busy ? (
        <output>Taking you to secure checkout…</output>
      ) : (
        <>
          {error ? (
            <p role="alert" className="field-error">
              {error} <a href={docs}>Self-hosting documentation</a>
            </p>
          ) : (
            <p>Choose a plan and billing interval to continue.</p>
          )}
          <div className="billing-fields">
            <label>
              Plan
              <select
                value={plan}
                onChange={(event) =>
                  setPlan(event.target.value === "pro" ? "pro" : "plus")
                }
              >
                <option value="plus">Plus — 50 GB</option>
                <option value="pro">Pro — 500 GB</option>
              </select>
            </label>
            <label>
              Billing interval
              <select
                value={interval}
                onChange={(event) =>
                  setInterval(event.target.value === "year" ? "year" : "month")
                }
              >
                <option value="month">Monthly</option>
                <option value="year">Yearly</option>
              </select>
            </label>
          </div>
          <p className="billing-price">
            {price(plans[plan].prices[interval].amount, interval)}
          </p>
          <Button onClick={() => void checkout(plan, interval)}>
            Continue to checkout
          </Button>
        </>
      )}
    </Frame>
  );
}
export function WelcomePage() {
  const [sessionId] = useState(
    () =>
      new URLSearchParams(window.location.search).get("session_id") ??
      sessionStorage.getItem("billing-checkout-session") ??
      "",
  );
  const valid = /^cs_(test|live)_[A-Za-z0-9]{1,200}$/.test(sessionId);
  useEffect(() => {
    const url = new URL(window.location.href);
    if (valid) sessionStorage.setItem("billing-checkout-session", sessionId);
    else sessionStorage.removeItem("billing-checkout-session");
    url.searchParams.delete("session_id");
    window.history.replaceState(
      window.history.state,
      "",
      `${url.pathname}${url.search}${url.hash}`,
    );
  }, [sessionId, valid]);
  const [checkoutQueryKey] = useState(() => crypto.randomUUID());
  const status = useQuery({
    queryKey: ["billing", "checkout-status", checkoutQueryKey],
    queryFn: () => billing.checkoutStatus({ sessionId }),
    enabled: valid,
    refetchInterval: (query) =>
      query.state.data?.state === "pending" ? 3000 : false,
  });
  const [name, setName] = useState("");
  const [localPart, setLocalPart] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [estimate, setEstimate] = useState<{
    value: string;
    score: number;
  } | null>(null);
  useEffect(() => {
    if (!password) return undefined;
    let current = true;
    void import("../vault/strength.ts")
      .then(({ strength }) => {
        if (current)
          setEstimate({ value: password, score: strength(password) });
        return undefined;
      })
      .catch(() => {
        /* Strength feedback is optional. */
      });
    return () => {
      current = false;
    };
  }, [password]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [email, setEmail] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    if (password.length < 12) {
      setError("Use at least 12 characters for your password.");
      return;
    }
    if (password !== confirmation) {
      setError("Passwords do not match.");
      return;
    }
    if (
      !/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(localPart.trim().toLowerCase()) ||
      localPart.trim().length < 3 ||
      localPart.trim().length > 40
    ) {
      setError(
        "Use 3–40 letters, numbers, dots, underscores or hyphens for your address.",
      );
      return;
    }
    setBusy(true);
    try {
      const result = await billing.claim({
        sessionId,
        name: name.trim(),
        localPart: localPart.trim().toLowerCase(),
        password,
      });
      sessionStorage.removeItem("billing-checkout-session");
      setEmail(result.email);
      setPassword("");
      setConfirmation("");
    } catch (failure) {
      setError(billingError(failure));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Frame title={email ? "Your account is ready" : "Welcome to Esuno"}>
      {email ? (
        <>
          <p>Your account {email} is ready.</p>
          <Button asChild>
            <a href="/login">Sign in</a>
          </Button>
        </>
      ) : !valid ? (
        <p role="alert">
          This checkout link is invalid. Contact support for help.
        </p>
      ) : status.isError ? (
        <div role="alert">
          <p>We could not check your payment. Please try again.</p>
          <Button variant="secondary" onClick={() => void status.refetch()}>
            Try again
          </Button>
        </div>
      ) : status.isPending || status.data.state === "pending" ? (
        <output>Confirming your payment…</output>
      ) : status.data.state === "expired" ? (
        <p>This checkout has expired. Contact support for help.</p>
      ) : status.data.state === "claimed" ? (
        <>
          <p>This account is already set up.</p>
          <Button asChild>
            <a href="/login">Sign in</a>
          </Button>
        </>
      ) : (
        <>
          <p>
            Create your account for{" "}
            {status.data.plan ? plans[status.data.plan].name : "Esuno Cloud"}.
          </p>
          <form className="auth-form" onSubmit={(event) => void submit(event)}>
            <TextField
              label="Name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={100}
              autoComplete="name"
              required
            />
            <TextField
              label="Address"
              description={`Your address will end in @${status.data.domain}.`}
              value={localPart}
              onChange={(event) => setLocalPart(event.target.value)}
              autoComplete="username"
              required
            />
            <TextField
              label="Password"
              description="At least 12 characters."
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              maxLength={256}
              required
            />
            {password && estimate?.value === password && (
              <p className="billing-muted">
                Password strength:{" "}
                {
                  ["Very weak", "Weak", "Fair", "Strong", "Very strong"][
                    estimate.score
                  ]
                }
              </p>
            )}
            <TextField
              label="Confirm password"
              type="password"
              autoComplete="new-password"
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
              required
            />
            {error && (
              <p role="alert" className="field-error">
                {error}
              </p>
            )}
            <Button type="submit" disabled={busy}>
              {busy ? "Creating account…" : "Create account"}
            </Button>
          </form>
        </>
      )}
    </Frame>
  );
}
