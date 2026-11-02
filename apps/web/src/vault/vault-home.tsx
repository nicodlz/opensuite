import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { z } from "zod";
import { isAdministrator, meQuery } from "../setup/client.ts";
import { Button } from "../ui/button.tsx";

const Status = z.object({
  enabled: z.boolean(),
  reachable: z.boolean(),
  version: z.string().nullable().optional(),
  checkedAt: z.iso.datetime().nullable().optional(),
});
async function getStatus() {
  const response = await fetch("/api/vault/status", {
    credentials: "same-origin",
    cache: "no-store",
    signal: AbortSignal.timeout(4000),
  });
  if (!response.ok) throw new Error("Status unavailable");
  return Status.parse(await response.json());
}
function useVaultStatus() {
  return useQuery({
    queryKey: ["vault-status"],
    queryFn: getStatus,
    refetchInterval: 30_000,
  });
}

export function Home({ origin }: { origin: string | undefined }) {
  return (
    <div className="content-wrap vault-content">
      <div className="page-breadcrumb">
        WORKSPACE <span>/</span> VAULT
      </div>
      <div className="page-header">
        <div>
          <p className="eyebrow">YOUR PASSWORD MANAGER</p>
          <h1>Esuno Vault</h1>
          <p className="page-subtitle">Your vault, on your own server.</p>
        </div>
      </div>
      <VaultStatus origin={origin} />
      <VaultOverviewCards />
    </div>
  );
}

function VaultStatus({ origin }: { origin: string | undefined }) {
  const status = useVaultStatus();
  return (
    <>
      {origin === undefined || status.data?.enabled === false ? (
        <VaultDisabled />
      ) : (
        <>
          <section className="vault-hero">
            <div>
              <p className="eyebrow">YOUR VAULT</p>
              <h2>Everything in one secure place</h2>
              <p>
                Open the web vault to manage your passwords and other private
                items.
              </p>
              <Button asChild>
                <a href={origin} target="_blank" rel="noopener noreferrer">
                  Open your vault ↗
                </a>
              </Button>
            </div>
            <img src="/vault-mark.svg" alt="" />
          </section>
          <ConnectionStatus status={status} />
        </>
      )}
    </>
  );
}

/** Setup steps are shown only to administrators; others are told whom to ask. */
function VaultDisabled() {
  const administrator = isAdministrator(useQuery(meQuery));
  return (
    <section className="empty-card" aria-labelledby="vault-disabled-heading">
      <div className="check-icon" aria-hidden="true">
        ◇
      </div>
      <h2 id="vault-disabled-heading">Vault is not enabled</h2>
      {administrator ? (
        <>
          <p>
            Vault is not set up on this server yet. The password generator works
            on this device in the meantime.
          </p>
          <div className="vault-operator">
            <h3>For administrators</h3>
            <p>
              Set VAULT_PUBLIC_HOST and add the matching HTTPS origin as vault=
              in AUTH_PRODUCT_ORIGINS, then start the Compose vault profile and
              recreate the API. See docs/operations/vault.md on the server for
              setup.
            </p>
          </div>
        </>
      ) : (
        <p>
          Vault is not available on this server yet. Contact your administrator
          to turn it on. The password generator works on this device in the
          meantime.
        </p>
      )}
      <Link className="vault-link" to="/vault/generator">
        Open the generator →
      </Link>
    </section>
  );
}

function ConnectionStatus({
  status,
}: {
  status: ReturnType<typeof useVaultStatus>;
}) {
  const refreshing = status.isFetching;
  return (
    <section className="vault-card" aria-labelledby="vault-connection-heading">
      <div className="vault-status-head">
        <div>
          <p className="eyebrow">CONNECTION STATUS</p>
          <h2 id="vault-connection-heading" aria-live="polite">
            {status.isPending
              ? "Checking connection"
              : status.isError
                ? "Status unavailable"
                : status.data.reachable
                  ? "Reachable"
                  : "Not reachable"}
          </h2>
        </div>
        {status.isSuccess && (
          <span
            className={`status-badge ${status.data.reachable ? "status-ok" : "status-degraded"}`}
          >
            {status.data.reachable ? "Online" : "Check connection"}
          </span>
        )}
      </div>
      {status.isError ? (
        <p>
          Could not check the vault server. Your vault may still work; try again
          in a moment.
        </p>
      ) : status.isSuccess ? (
        <>
          <p>Version: {status.data.version ?? "Unknown"}</p>
          <p>
            Last checked:{" "}
            {status.data.checkedAt
              ? new Date(status.data.checkedAt).toLocaleString()
              : "Not checked"}
          </p>
        </>
      ) : null}
      <Button
        variant="secondary"
        size="small"
        aria-disabled={refreshing}
        onClick={() => {
          if (!refreshing) void status.refetch();
        }}
      >
        {refreshing ? "Checking…" : "Refresh status"}
      </Button>
    </section>
  );
}

function VaultOverviewCards() {
  return (
    <>
      <div className="checks-grid vault-cards">
        <section className="vault-card">
          <div className="check-icon" aria-hidden="true">
            ◇
          </div>
          <h2>A separate master password</h2>
          <p>
            Your vault master password is separate from your Esuno sign-in. It
            is never sent to Esuno.
          </p>
        </section>
        <section className="vault-card">
          <div className="check-icon" aria-hidden="true">
            ↗
          </div>
          <h2>Take Vault with you</h2>
          <p>
            Connect the official browser, desktop, mobile and CLI clients to
            your server.
          </p>
          <Link className="vault-link" to="/vault/clients">
            Set up your clients →
          </Link>
        </section>
      </div>
      <section className="vault-card vault-alias">
        <h2>Hide-my-email aliases</h2>
        <p>Create addresses that forward to your mailbox.</p>
        <Link className="vault-link" to="/vault/aliases">
          Manage aliases →
        </Link>
      </section>
    </>
  );
}
