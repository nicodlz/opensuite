import * as React from "react";
import { Button } from "../ui/button.tsx";
import { aliasesClient } from "./client.ts";
import { aliasError } from "./model.ts";
import { useAliasPage, type AliasPageState } from "./use-alias-page.ts";
import { AliasList } from "./alias-list.tsx";
import { AliasCreateDialog, AliasDeleteDialog } from "./alias-dialogs.tsx";
import { ApiKeysPanel, ApiKeyDialog } from "./api-keys.tsx";
// oxlint-disable-next-line import/no-unassigned-import
import "./aliases.css";

export function AliasesPage() {
  const state = useAliasPage();
  return (
    <div className="content-wrap vault-content">
      <AliasHeader state={state} />
      <AliasList state={state} />
      <DefaultDomainPicker state={state} />
      <ApiKeysPanel state={state} />
      <AliasInstructions />
      <AliasCreateDialog state={state} />
      <AliasDeleteDialog state={state} />
      <ApiKeyDialog state={state} />
    </div>
  );
}

function AliasHeader({ state }: { state: AliasPageState }) {
  const {
    list,
    keys,
    defaultDomain,
    creating,
    setCreating,
    deleting,
    keyDialog,
    error,
    setError,
    notice,
    domains,
    refresh,
  } = state;
  const loadError =
    list.error ?? domains.error ?? defaultDomain.error ?? keys.error;
  return (
    <>
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
    </>
  );
}

function DefaultDomainPicker({ state }: { state: AliasPageState }) {
  const { busy, setNotice, domains, defaultDomain, run } = state;
  return (
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
          No eligible domains are available. Ask your administrator to verify a
          domain.
        </p>
      )}
    </section>
  );
}

function AliasInstructions() {
  return (
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
  );
}
