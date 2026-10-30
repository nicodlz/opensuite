import * as React from "react";
import { useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ORPCError } from "@orpc/client";
import { AppShell, SidebarLink } from "../shell/app-shell.tsx";
import { Button } from "../ui/button.tsx";
import { TextField } from "../ui/text-field.tsx";
import { Dialog, DialogContent } from "../ui/dialog.tsx";
import { addressesClient } from "./client.ts";
// oxlint-disable-next-line import/no-unassigned-import
import "../aliases/aliases.css";
// oxlint-disable-next-line import/no-unassigned-import
import "../vault/vault.css";

function errorText(error: unknown) {
  if (error instanceof ORPCError) {
    if (error.code === "CONFLICT") return "This address is already taken.";
    if (error.code === "RESERVED") return "This address name is reserved.";
    if (error.code === "ADDRESS_LIMIT_REACHED") return "Address limit reached.";
    if (error.code === "BAD_REQUEST")
      return "Check the address name and domain.";
    if (error.code === "TOO_MANY_REQUESTS")
      return "Too many requests. Try again later.";
  }
  return "Could not update addresses. Please try again.";
}
export function AddressesPage() {
  const cache = useQueryClient();
  const list = useQuery({
    queryKey: ["addresses"],
    queryFn: () => addressesClient.list({}),
  });
  const domains = useQuery({
    queryKey: ["addresses", "domains"],
    queryFn: () => addressesClient.domains({}),
  });
  const [part, setPart] = useState("");
  const [domainId, setDomainId] = useState("");
  const [deleting, setDeleting] = useState<{
    id: string;
    address: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  async function run(action: () => Promise<unknown>, message: string) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
      await cache.invalidateQueries({ queryKey: ["addresses"] });
      setNotice(message);
      return true;
    } catch (cause) {
      setError(errorText(cause));
      return false;
    } finally {
      setBusy(false);
    }
  }
  function create(event: FormEvent) {
    event.preventDefault();
    void run(
      () =>
        addressesClient.create({
          localPart: part,
          domainId: domainId || domains.data?.[0]?.id || "",
        }),
      "Address added.",
    ).then((success) => {
      if (success) setPart("");
      return undefined;
    });
  }
  const data = list.data;
  return (
    <AppShell
      product="mail"
      sidebar={
        <>
          <p className="shell-nav-heading">Workspace settings</p>
          <SidebarLink
            to="/settings/addresses"
            icon="mail"
            label="Addresses"
            active
          />
          <SidebarLink
            to="/settings/billing"
            icon="settings"
            label="Plan & storage"
          />
        </>
      }
    >
      <div className="content-wrap vault-content">
        <div className="page-breadcrumb">
          WORKSPACE <span>/</span> SETTINGS
        </div>
        <div className="page-header">
          <div>
            <p className="eyebrow">WORKSPACE SETTINGS</p>
            <h1>Addresses</h1>
            <p className="page-subtitle">
              Receive mail and sign in with any of your mailbox addresses.
            </p>
          </div>
        </div>
        {notice && <output className="alias-notice">{notice}</output>}
        {error && (
          <p className="field-error" role="alert">
            {error}{" "}
            {error === "Address limit reached." && (
              <a href="/settings/billing">Plan settings</a>
            )}
          </p>
        )}
        {(list.isError || domains.isError) && (
          <p role="alert">
            Could not load addresses or domains. Please refresh and try again.
          </p>
        )}
        <section className="vault-card">
          <h2>Your addresses</h2>
          {!data ? (
            <p>Loading addresses…</p>
          ) : (
            <>
              <p aria-live="polite">
                {data.addresses.length} of {data.limit ?? "unlimited"} used
              </p>
              <ul className="alias-list">
                {data.addresses.map((item) => (
                  <li className="alias-row" key={item.id}>
                    <div className="alias-details">
                      <strong>{item.address}</strong>
                      <div className="alias-badges">
                        {item.primary && (
                          <span className="status-badge">Primary</span>
                        )}
                        <span className="status-badge">
                          {item.removing
                            ? "Removing"
                            : item.ready
                              ? "Ready"
                              : "Pending"}
                        </span>
                      </div>
                    </div>
                    {!item.primary && !item.removing && (
                      <Button
                        variant="secondary"
                        size="small"
                        disabled={busy}
                        onClick={() => setDeleting(item)}
                      >
                        Remove
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
        <section className="vault-card">
          <h2>Add an address</h2>
          <p>Choose a name and an available domain.</p>
          <form className="alias-form" onSubmit={create}>
            <TextField
              label="Address name"
              value={part}
              onChange={(event) => setPart(event.target.value)}
              required
              maxLength={39}
            />
            <label>
              Domain
              <select
                value={domainId || domains.data?.[0]?.id || ""}
                onChange={(event) => setDomainId(event.target.value)}
                required
              >
                <option value="" disabled>
                  Select a domain
                </option>
                {domains.data?.map((domain) => (
                  <option key={domain.id} value={domain.id}>
                    {domain.name}
                  </option>
                ))}
              </select>
            </label>
            {data?.remaining === 0 && (
              <p>
                Address limit reached.{" "}
                <a href="/settings/billing">Plan settings</a>
              </p>
            )}
            <div>
              <Button
                type="submit"
                disabled={
                  busy || !domains.data?.length || data?.remaining === 0
                }
              >
                Add address
              </Button>
            </div>
          </form>
        </section>
        <Dialog
          open={deleting !== null}
          onOpenChange={(open) => {
            if (!open && !busy) setDeleting(null);
          }}
        >
          <DialogContent
            title="Remove address?"
            description="Mail sent to this address will stop arriving. Existing mail will not be deleted."
          >
            <p className="alias-confirm-address">{deleting?.address}</p>
            <div className="dialog-actions">
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() => setDeleting(null)}
              >
                Cancel
              </Button>
              <Button
                disabled={busy}
                onClick={() => {
                  if (deleting)
                    void run(
                      () => addressesClient.remove({ id: deleting.id }),
                      "Address removed.",
                    ).then((success) => {
                      if (success) setDeleting(null);
                      return undefined;
                    });
                }}
              >
                Remove address
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </div>
    </AppShell>
  );
}
