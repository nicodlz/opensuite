import * as React from "react";
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  plans,
  entitledStatuses,
  type BillingInterval,
  type BillingOverview,
  type PlanId,
} from "@opensuite/contracts";
import { AppShell, SidebarLink } from "../shell/app-shell.tsx";
import { Button } from "../ui/button.tsx";
import { billing, billingQuery } from "./client.ts";
import { billingError, bytes, price, statusText, usageState } from "./model.ts";
// Vite injects the stylesheet.
// oxlint-disable-next-line import/no-unassigned-import
import "./billing.css";

function StorageUsage({ storage }: { storage: BillingOverview["storage"] }) {
  if (!storage.measured) return <p>Usage temporarily unavailable.</p>;
  const { quotaBytes, usedBytes, driveBytes, mailBytes } = storage;
  const state = usageState(storage);
  return (
    <div className="billing-usage">
      <div className="billing-usage-heading">
        <strong>{bytes(usedBytes)} used</strong>
        <span>
          {quotaBytes === null
            ? "No storage quota"
            : `${bytes(Math.max(0, quotaBytes - usedBytes))} available of ${bytes(quotaBytes)}`}
        </span>
      </div>
      {quotaBytes !== null && quotaBytes > 0 && (
        <progress
          className={`billing-meter ${state}`}
          value={Math.min(usedBytes, quotaBytes)}
          max={quotaBytes}
          aria-label="Storage used"
        />
      )}
      <p>
        Drive {bytes(driveBytes)} · Mail {bytes(mailBytes)}
      </p>
      {state === "warning" && (
        <p className="billing-warning">
          You have used at least 80% of your storage.
        </p>
      )}
      {state === "critical" && (
        <p className="billing-warning">
          You have used at least 95% of your storage.
        </p>
      )}
      {state === "over" && (
        <output className="billing-warning">
          Storage quota reached: new uploads and incoming mail are paused;
          nothing is deleted.
        </output>
      )}
    </div>
  );
}

function date(value: string | null) {
  if (!value || Number.isNaN(Date.parse(value))) return null;
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(
    new Date(value),
  );
}
export function BillingSettings() {
  const overview = useQuery(billingQuery);
  const [plan, setPlan] = useState<PlanId>("plus");
  const [interval, setInterval] = useState<BillingInterval>("month");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirm, setConfirm] = useState(false);
  const [returned] = useState(() =>
    new URLSearchParams(window.location.search).get("billing"),
  );
  useEffect(() => {
    const url = new URL(window.location.href);
    if (url.searchParams.has("billing")) {
      url.searchParams.delete("billing");
      window.history.replaceState(
        window.history.state,
        "",
        `${url.pathname}${url.search}${url.hash}`,
      );
    }
  }, []);
  const refetch = overview.refetch;
  useEffect(() => {
    if (returned !== "updated") return undefined;
    const timers = [2000, 5000, 10000, 20000].map((delay) =>
      window.setTimeout(() => {
        void refetch();
      }, delay),
    );
    return () => timers.forEach(window.clearTimeout);
  }, [returned, refetch]);
  async function redirect(action: "checkout" | "change" | "portal") {
    setBusy(true);
    setError("");
    try {
      const result =
        action === "portal"
          ? await billing.portal({})
          : await billing[action]({ plan, interval });
      window.location.assign(result.url);
    } catch (failure) {
      setError(billingError(failure));
      setBusy(false);
    }
  }
  const data = overview.data;
  const subscription = data?.subscription;
  const end = date(subscription?.currentPeriodEnd ?? null);
  const ended = date(subscription?.endedAt ?? null);
  const entitled =
    subscription !== null &&
    subscription !== undefined &&
    entitledStatuses.some((status) => status === subscription.status);
  const paid = data?.plan === "plus" || data?.plan === "pro";
  const downgradeRisk =
    data?.storage.measured === true &&
    paid &&
    plans[plan].storageBytes < (data.storage.quotaBytes ?? 0) &&
    data.storage.usedBytes > plans[plan].storageBytes;
  return (
    <AppShell
      product="mail"
      sidebar={
        <>
          <p className="shell-nav-heading">Workspace settings</p>
          <SidebarLink
            to="/settings/billing"
            icon="settings"
            label="Plan & storage"
            active
          />
        </>
      }
    >
      <div className="content-wrap billing-page">
        <div className="page-breadcrumb">
          WORKSPACE <span>/</span> SETTINGS
        </div>
        <div className="page-header">
          <div>
            <p className="eyebrow">WORKSPACE SETTINGS</p>
            <h1>Plan &amp; storage</h1>
            <p className="page-subtitle">
              Your subscription and shared storage for Mail and Drive.
            </p>
          </div>
        </div>
        {returned === "updated" && (
          <output className="billing-info">
            Your plan updates as soon as Stripe confirms the change.
          </output>
        )}
        {returned === "canceled" && (
          <output className="billing-info">
            You returned from Stripe. Check your plan below for its current
            status.
          </output>
        )}
        {overview.isPending && <p>Loading plan and storage…</p>}
        {overview.isError && (
          <div role="alert">
            <p>Could not load plan and storage. Please try again.</p>
            <Button variant="secondary" onClick={() => void overview.refetch()}>
              Retry
            </Button>
          </div>
        )}
        {data && (
          <>
            <section className="billing-card" aria-labelledby="plan-heading">
              <p className="eyebrow">YOUR PLAN</p>
              <h2 id="plan-heading">
                {data.mode === "self-hosted"
                  ? "Self-hosted"
                  : data.source === "grant"
                    ? "Complimentary plan"
                    : data.exempt
                      ? "Operator account"
                      : paid
                        ? data.plan === "pro"
                          ? plans.pro.name
                          : plans.plus.name
                        : "No plan"}
              </h2>
              {data.mode === "self-hosted" ? (
                <p>Self-hosted — no subscription, no Esuno storage quota.</p>
              ) : data.source === "grant" ? (
                <p>
                  {data.exempt
                    ? "Complimentary — no plan limits"
                    : `Complimentary plan — ${plans[data.plan === "pro" ? "pro" : "plus"].name}`}
                </p>
              ) : data.exempt ? (
                <p>Operator account — no plan limits.</p>
              ) : (
                <>
                  {subscription ? (
                    <>
                      <p className="billing-price">
                        {price(subscription.amount, subscription.interval)}
                      </p>
                      <p>{statusText(subscription.status)}</p>
                      {ended && !subscription.cancelAtPeriodEnd && (
                        <p>Ended: {ended}</p>
                      )}
                      {subscription.cancelAtPeriodEnd ? (
                        <p>
                          Cancellation scheduled
                          {end
                            ? ` — your plan ends ${end}`
                            : " at the end of the billing period"}
                          .
                        </p>
                      ) : (
                        end && !ended && <p>Next renewal: {end}</p>
                      )}
                    </>
                  ) : (
                    <p>Choose a plan to activate your Cloud account.</p>
                  )}
                  {subscription && (
                    <Button
                      variant="secondary"
                      disabled={busy}
                      onClick={() => void redirect("portal")}
                    >
                      Manage billing
                    </Button>
                  )}
                  {subscription && (
                    <p className="billing-muted">
                      Update your payment method, view invoices, or cancel in
                      the billing portal.
                    </p>
                  )}
                </>
              )}
            </section>
            <section className="billing-card" aria-labelledby="storage-heading">
              <p className="eyebrow">SHARED STORAGE</p>
              <h2 id="storage-heading">Storage</h2>
              <StorageUsage storage={data.storage} />
            </section>
            {data.mode === "cloud" &&
              !data.exempt &&
              data.source !== "grant" && (
                <section
                  className="billing-card"
                  aria-labelledby="choose-heading"
                >
                  <p className="eyebrow">ESUNO CLOUD</p>
                  <h2 id="choose-heading">
                    {entitled ? "Change your plan" : "Choose your plan"}
                  </h2>
                  <p>Review the change on Stripe before confirming.</p>
                  <div className="billing-fields">
                    <label>
                      Plan
                      <select
                        value={plan}
                        onChange={(event) => {
                          setPlan(
                            event.target.value === "pro" ? "pro" : "plus",
                          );
                          setConfirm(false);
                        }}
                      >
                        <option value="plus">Plus — 50 GB</option>
                        <option value="pro">Pro — 500 GB</option>
                      </select>
                    </label>
                    <label>
                      Billing interval
                      <select
                        value={interval}
                        onChange={(event) => {
                          setInterval(
                            event.target.value === "year" ? "year" : "month",
                          );
                          setConfirm(false);
                        }}
                      >
                        <option value="month">Monthly</option>
                        <option value="year">Yearly</option>
                      </select>
                    </label>
                  </div>
                  <p className="billing-price">
                    {price(plans[plan].prices[interval].amount, interval)}
                  </p>
                  {confirm && (
                    <p className="billing-warning" role="alert">
                      Your usage is above this plan’s quota. Nothing is deleted,
                      but uploads and incoming mail will pause until usage is
                      below the limit.
                    </p>
                  )}
                  <Button
                    disabled={
                      busy ||
                      (paid &&
                        plan === data.plan &&
                        interval === subscription?.interval)
                    }
                    onClick={() => {
                      if (downgradeRisk && !confirm) {
                        setConfirm(true);
                        return;
                      }
                      void redirect(entitled ? "change" : "checkout");
                    }}
                  >
                    {busy
                      ? "Opening Stripe…"
                      : confirm
                        ? "Continue with downgrade"
                        : entitled
                          ? "Continue to change plan"
                          : "Continue to checkout"}
                  </Button>
                </section>
              )}
            {error && (
              <p className="field-error" role="alert">
                {error}
              </p>
            )}
          </>
        )}
      </div>
    </AppShell>
  );
}
