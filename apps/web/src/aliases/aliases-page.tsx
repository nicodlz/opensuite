import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState, type FormEvent } from "react";
import { Button } from "../ui/button.tsx";
import { Dialog, DialogContent } from "../ui/dialog.tsx";
import { TextField } from "../ui/text-field.tsx";
import { aliasesClient, type Alias } from "./client.ts";
import {
  aliasError,
  aliasState,
  filterAliases,
  type AliasFilter,
} from "./model.ts";
// oxlint-disable-next-line import/no-unassigned-import
import "./aliases.css";

export function AliasesPage() {
  const queryClient = useQueryClient();
  const list = useQuery({
    queryKey: ["aliases", "list"],
    queryFn: () => aliasesClient.list({}),
  });
  const domains = useQuery({
    queryKey: ["aliases", "domains"],
    queryFn: () => aliasesClient.domains({}),
  });
  const defaultDomain = useQuery({
    queryKey: ["aliases", "default"],
    queryFn: () => aliasesClient.getDefault({}),
  });
  const keys = useQuery({
    queryKey: ["aliases", "keys"],
    queryFn: () => aliasesClient.listKeys({}),
  });
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<AliasFilter>("all");
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<Alias | null>(null);
  const [keyDialog, setKeyDialog] = useState(false);
  const [keyName, setKeyName] = useState("");
  const [secret, setSecret] = useState("");
  const [domainId, setDomainId] = useState("");
  const [prefix, setPrefix] = useState("");
  const [mode, setMode] = useState<"random" | "prefix">("random");
  const [website, setWebsite] = useState("");
  const [note, setNote] = useState("");
  const request = useRef<{ id: string; payload: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: ["aliases"] });
  async function run(action: () => Promise<unknown>, success: () => void) {
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
      success();
      await refresh();
    } catch (cause) {
      setError(aliasError(cause));
    } finally {
      setBusy(false);
    }
  }
  function closeCreate() {
    setCreating(false);
    setPrefix("");
    setWebsite("");
    setNote("");
    setMode("random");
    setDomainId("");
    request.current = null;
    setError("");
  }
  function create(event: FormEvent) {
    event.preventDefault();
    const input = {
      domainId:
        domainId || defaultDomain.data?.domainId || domains.data?.[0]?.id,
      ...(mode === "prefix" ? { prefix: prefix.trim() } : {}),
      ...(website.trim() ? { website: website.trim() } : {}),
      ...(note.trim() ? { note: note.trim() } : {}),
    };
    const payload = JSON.stringify(input);
    if (request.current?.payload !== payload)
      request.current = { id: crypto.randomUUID(), payload };
    const requestId = request.current.id;
    void run(
      () => aliasesClient.create({ ...input, requestId }),
      () => {
        closeCreate();
        setNotice("Alias created.");
      },
    );
  }
  function createKey(event: FormEvent) {
    event.preventDefault();
    void run(
      async () => {
        const result = await aliasesClient.createKey({ name: keyName });
        setSecret(result.secret);
      },
      () => setKeyName(""),
    );
  }
  function copy(value: string) {
    void Promise.resolve()
      .then(() => navigator.clipboard.writeText(value))
      .then(
        () => setNotice("Copied to clipboard."),
        () =>
          setNotice("Could not copy. Select the text and copy it manually."),
      );
  }
  const visible = filterAliases(list.data ?? [], filter).filter((alias) =>
    [alias.address, alias.website ?? "", alias.note ?? ""].some((value) =>
      value.toLowerCase().includes(search.trim().toLowerCase()),
    ),
  );
  const loadError =
    list.error ?? domains.error ?? defaultDomain.error ?? keys.error;
  return (
    <div className="content-wrap vault-content">
      <div className="page-breadcrumb">
        VAULT <span>/</span> ALIASES
      </div>
      <div className="page-header alias-heading">
        <div>
          <p className="eyebrow">HIDE MY EMAIL</p>
          <h1>Aliases</h1>
          <p className="page-subtitle">
            Use unique addresses that deliver to your mailbox.
          </p>
        </div>
        <Button
          onClick={() => {
            setError("");
            setCreating(true);
          }}
          disabled={!domains.data?.length}
        >
          Create alias
        </Button>
      </div>
      {notice && <output className="alias-notice">{notice}</output>}
      {error && !creating && !deleting && !keyDialog && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      {loadError && (
        <div role="alert" className="alias-error">
          <p>{aliasError(loadError)}</p>
          <Button
            variant="secondary"
            size="small"
            onClick={() => {
              void refresh();
            }}
          >
            Retry
          </Button>
        </div>
      )}
      <section className="vault-card">
        <div className="alias-toolbar">
          <label>
            Search aliases
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Address, website or note"
              type="search"
            />
          </label>
          <label>
            Filter
            <select
              value={filter}
              onChange={(event) => {
                const value = event.target.value;
                if (
                  value === "all" ||
                  value === "enabled" ||
                  value === "disabled" ||
                  value === "suspended"
                )
                  setFilter(value);
              }}
            >
              <option value="all">All aliases</option>
              <option value="enabled">Enabled</option>
              <option value="disabled">Disabled</option>
              <option value="suspended">Suspended</option>
            </select>
          </label>
        </div>
        {list.isPending ? (
          <p>Loading aliases…</p>
        ) : visible.length === 0 ? (
          <p>No aliases found.</p>
        ) : (
          <ul className="alias-list" aria-label="Aliases">
            {visible.map((alias) => (
              <li className="alias-row" key={alias.id}>
                <div className="alias-details">
                  <strong>{alias.address}</strong>
                  <div className="alias-badges">
                    <span className="status-badge">
                      {alias.enabled ? "Enabled" : "Disabled"}
                    </span>
                    <span className="status-badge">{aliasState(alias)}</span>
                  </div>
                  {alias.website && <p>Website: {alias.website}</p>}
                  {alias.note && <p>{alias.note}</p>}
                </div>
                <div className="alias-actions">
                  <Button
                    variant="secondary"
                    size="small"
                    onClick={() => copy(alias.address)}
                    aria-label={`Copy ${alias.address}`}
                  >
                    Copy
                  </Button>
                  <Button
                    variant="secondary"
                    size="small"
                    disabled={busy}
                    onClick={() => {
                      void run(
                        () =>
                          alias.enabled
                            ? aliasesClient.disable({ id: alias.id })
                            : aliasesClient.enable({ id: alias.id }),
                        () =>
                          setNotice(
                            alias.enabled
                              ? "Alias disabled."
                              : "Alias enabled.",
                          ),
                      );
                    }}
                  >
                    {alias.enabled ? "Disable" : "Enable"}
                  </Button>
                  <Button
                    variant="ghost"
                    size="small"
                    disabled={busy}
                    onClick={() => {
                      setError("");
                      setDeleting(alias);
                    }}
                  >
                    Delete
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="vault-card">
        <h2>Default alias domain</h2>
        <p>Bitwarden uses this domain when generating an alias.</p>
        {domains.data?.length ? (
          <label className="alias-domain">
            Default domain
            <select
              value={defaultDomain.data?.domainId ?? ""}
              disabled={busy || defaultDomain.isPending}
              onChange={(event) => {
                const id = event.target.value;
                if (id)
                  void run(
                    () => aliasesClient.setDefault({ domainId: id }),
                    () => setNotice("Default domain updated."),
                  );
              }}
            >
              <option value="" disabled>
                Select a domain
              </option>
              {domains.data.map((domain) => (
                <option key={domain.id} value={domain.id}>
                  {domain.name}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <p>
            No eligible domains are available. Ask your administrator to verify
            a domain.
          </p>
        )}
      </section>
      <section className="vault-card">
        <div className="alias-section-heading">
          <div>
            <h2>Alias API keys</h2>
            <p>Keys allow a generator to create aliases for your account.</p>
          </div>
          <Button
            variant="secondary"
            onClick={() => {
              setError("");
              setKeyDialog(true);
            }}
          >
            Create API key
          </Button>
        </div>
        {keys.isPending ? (
          <p>Loading keys…</p>
        ) : !keys.data?.length ? (
          <p>No API keys yet.</p>
        ) : (
          <ul className="alias-list" aria-label="Alias API keys">
            {keys.data.map((key) => (
              <li key={key.id} className="alias-row">
                <div className="alias-details">
                  <strong>{key.name}</strong>
                  <p>
                    <code>{key.prefix}</code> ·{" "}
                    {key.revokedAt ? "Revoked" : "Active"} · Last used:{" "}
                    {key.lastUsedAt
                      ? new Date(key.lastUsedAt).toLocaleString()
                      : "Never"}
                  </p>
                </div>
                {!key.revokedAt && (
                  <Button
                    variant="secondary"
                    size="small"
                    disabled={busy}
                    onClick={() => {
                      void run(
                        () => aliasesClient.revokeKey({ id: key.id }),
                        () => setNotice("API key revoked."),
                      );
                    }}
                  >
                    Revoke
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="vault-card">
        <h2>Use with Bitwarden</h2>
        <ol className="alias-instructions">
          <li>
            Select a default alias domain above and create an API key. Copy the
            key when it appears.
          </li>
          <li>
            In Bitwarden, open Generator → Username → Forwarded email alias →
            SimpleLogin.
          </li>
          <li>
            Set the self-hosted server URL to{" "}
            <code>{window.location.origin}</code> and enter your alias API key.
          </li>
          <li>Generate a username. The new alias appears in this list.</li>
        </ol>
      </section>
      <Dialog
        open={creating}
        onOpenChange={(open) => {
          if (!open && !busy) closeCreate();
        }}
      >
        <DialogContent
          title="Create alias"
          description="Create an address that forwards to your mailbox."
        >
          <form className="alias-form" onSubmit={create}>
            <fieldset>
              <legend>Address</legend>
              <div className="vault-options">
                <label>
                  <input
                    type="radio"
                    name="alias-mode"
                    checked={mode === "random"}
                    onChange={() => setMode("random")}
                  />{" "}
                  Random
                </label>
                <label>
                  <input
                    type="radio"
                    name="alias-mode"
                    checked={mode === "prefix"}
                    onChange={() => setMode("prefix")}
                  />{" "}
                  With prefix
                </label>
              </div>
            </fieldset>
            {mode === "prefix" && (
              <TextField
                label="Prefix"
                description="Letters, numbers, dots and hyphens. A random suffix is added."
                value={prefix}
                onChange={(event) => setPrefix(event.target.value)}
                required
                maxLength={39}
                pattern="[A-Za-z0-9]+([.-][A-Za-z0-9]+)*"
              />
            )}
            <label>
              Domain
              <select
                value={
                  domainId ||
                  defaultDomain.data?.domainId ||
                  domains.data?.[0]?.id ||
                  ""
                }
                onChange={(event) => setDomainId(event.target.value)}
                required
              >
                {domains.data?.map((domain) => (
                  <option key={domain.id} value={domain.id}>
                    {domain.name}
                  </option>
                ))}
              </select>
            </label>
            <TextField
              label="Website (optional)"
              description="A hostname, such as example.com."
              value={website}
              onChange={(event) => setWebsite(event.target.value)}
              maxLength={253}
            />
            <label>
              Note (optional)
              <textarea
                value={note}
                onChange={(event) => setNote(event.target.value)}
                maxLength={500}
                rows={3}
              />
            </label>
            {error && (
              <p className="field-error" role="alert">
                {error} Retry without changing the details to recover the same
                request. Changing details may create another alias.
              </p>
            )}
            <div className="dialog-actions">
              <Button
                type="button"
                variant="ghost"
                disabled={busy}
                onClick={closeCreate}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={busy}>
                Create alias
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open && !busy) {
            setDeleting(null);
            setError("");
          }
        }}
      >
        <DialogContent
          title="Delete alias?"
          description="This address will never be reused. Existing messages remain in your mailbox."
        >
          <p className="alias-confirm-address">{deleting?.address}</p>
          {error && (
            <p className="field-error" role="alert">
              {error}
            </p>
          )}
          <div className="dialog-actions">
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => setDeleting(null)}
            >
              Cancel
            </Button>
            <Button
              className="button-danger"
              disabled={busy}
              onClick={() => {
                if (deleting)
                  void run(
                    () => aliasesClient.delete({ id: deleting.id }),
                    () => {
                      setDeleting(null);
                      setNotice("Alias deleted.");
                    },
                  );
              }}
            >
              Delete alias
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog
        open={keyDialog}
        onOpenChange={(open) => {
          if (!open && !busy) {
            setKeyDialog(false);
            setSecret("");
            setKeyName("");
            setError("");
          }
        }}
      >
        <DialogContent
          title={secret ? "Copy your API key" : "Create API key"}
          description={
            secret
              ? "This key is shown only once. Copy and save it now; you cannot view it again."
              : "Give this key a name to identify the client that uses it."
          }
        >
          {secret ? (
            <div className="alias-form">
              <label>
                API key
                <textarea readOnly value={secret} rows={3} />
              </label>
              <Button variant="secondary" onClick={() => copy(secret)}>
                Copy API key
              </Button>
              {notice && <output>{notice}</output>}
              <div className="dialog-actions">
                <Button
                  onClick={() => {
                    setKeyDialog(false);
                    setSecret("");
                    setNotice("");
                  }}
                >
                  Done
                </Button>
              </div>
            </div>
          ) : (
            <form className="alias-form" onSubmit={createKey}>
              <TextField
                label="Key name"
                value={keyName}
                onChange={(event) => setKeyName(event.target.value)}
                required
                maxLength={100}
              />
              {error && (
                <p className="field-error" role="alert">
                  {error}
                </p>
              )}
              <div className="dialog-actions">
                <Button
                  type="button"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => setKeyDialog(false)}
                >
                  Cancel
                </Button>
                <Button type="submit" disabled={busy}>
                  Create key
                </Button>
              </div>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
