import * as React from "react";
import { useEffect, useRef } from "react";
import { Button } from "../ui/button.tsx";
import { aliasesClient } from "./client.ts";
import { aliasError, failedParts } from "./model.ts";
import { useAliasPage, type AliasPageState } from "./use-alias-page.ts";
import { AliasList } from "./alias-list.tsx";
import { AliasCreateDialog, AliasDeleteDialog } from "./alias-dialogs.tsx";
import { ApiKeysPanel, ApiKeyDialog } from "./api-keys.tsx";
// oxlint-disable-next-line import/no-unassigned-import
import "./aliases.css";

/**
 * A panel whose data failed to load is not shown: the page explains the
 * failure once, with Retry, instead of showing an empty list beside it.
 */
export function AliasesPage() {
  const state = useAliasPage();
  const { list, domains, defaultDomain, keys } = state;
  const domainFailed = domains.isError || defaultDomain.isError;
  return (
    <div className="content-wrap vault-content">
      <AliasHeader state={state} />
      {!list.isError && <AliasList state={state} />}
      {!domainFailed && <DefaultDomainPicker state={state} />}
      {!keys.isError && <ApiKeysPanel state={state} />}
      {!domainFailed && !keys.isError && <AliasInstructions />}
      <AliasCreateDialog state={state} />
      <AliasDeleteDialog state={state} />
      <ApiKeyDialog state={state} />
    </div>
  );
}

/** Why Create alias is unavailable, or null when it can be used. */
function createBlocker({ list, domains }: AliasPageState): string | null {
  if (list.isError || domains.isError)
    return "Available once your aliases and domains load.";
  if (domains.isPending) return "Loading alias domains…";
  if (domains.data.length === 0)
    return "No alias domain is available yet. Ask your administrator to verify one.";
  return null;
}

function AliasHeader({ state }: { state: AliasPageState }) {
  const { setError, setCreating, createButton } = state;
  const { list, domains, defaultDomain, keys } = state;
  const blocker = createBlocker(state);
  const title = useRef<HTMLHeadingElement>(null);
  const error =
    list.error ?? domains.error ?? defaultDomain.error ?? keys.error;
  const failed = useRef(false);
  useEffect(() => {
    // A successful Retry removes the focused button with the message.
    if (!error && failed.current && document.activeElement === document.body)
      title.current?.focus();
    failed.current = error !== null;
  }, [error]);
  return (
    <>
      <div className="page-breadcrumb">
        VAULT <span>/</span> ALIASES
      </div>
      <div className="page-header alias-heading">
        <div>
          <p className="eyebrow">HIDE MY EMAIL</p>
          <h1 ref={title} tabIndex={-1}>
            Aliases
          </h1>
          <p className="page-subtitle">
            Use unique addresses that deliver to your mailbox.
          </p>
        </div>
        <div className="alias-create">
          <Button
            ref={createButton}
            onClick={() => {
              setError("");
              setCreating(true);
            }}
            disabled={blocker !== null}
            aria-describedby={blocker ? "alias-create-blocker" : undefined}
          >
            Create alias
          </Button>
          {blocker && (
            <p id="alias-create-blocker" className="alias-create-blocker">
              {blocker}
            </p>
          )}
        </div>
      </div>
      {error && <LoadError state={state} error={error} />}
    </>
  );
}

function LoadError({ state, error }: { state: AliasPageState; error: Error }) {
  const { list, domains, defaultDomain, keys, refresh } = state;
  const retrying = [list, domains, defaultDomain, keys].some(
    (query) => query.isFetching,
  );
  return (
    <div role="alert" className="alias-error">
      <h2>
        Could not load{" "}
        {failedParts([
          { label: "your aliases", failed: list.isError },
          {
            label: "alias domains",
            failed: domains.isError || defaultDomain.isError,
          },
          { label: "API keys", failed: keys.isError },
        ])}
      </h2>
      <p>{aliasError(error)}</p>
      <Button
        variant="ghost"
        size="small"
        className="alias-action"
        aria-disabled={retrying}
        onClick={() => {
          if (!retrying) void refresh();
        }}
      >
        {retrying ? "Retrying…" : "Retry"}
      </Button>
    </div>
  );
}

function DefaultDomainPicker({ state }: { state: AliasPageState }) {
  const { busy, notify, domains, defaultDomain, run } = state;
  return (
    <section className="vault-card">
      <h2>Default alias domain</h2>
      <p>
        Used when a compatible password manager, such as Bitwarden, creates an
        alias for you.
      </p>
      {domains.isPending ? (
        <p>Loading domains…</p>
      ) : domains.data?.length ? (
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
                  () => notify({ message: "Default domain updated." }),
                  "notify",
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
          No alias domain is available yet. Ask your administrator to verify
          one.
        </p>
      )}
    </section>
  );
}

function AliasInstructions() {
  return (
    <section className="vault-card">
      <h2>Use with a password manager</h2>
      <p>
        Password managers that can forward email aliases through a
        SimpleLogin-compatible server, such as Bitwarden, can create aliases
        here.
      </p>
      <ol className="alias-instructions">
        <li>
          Select a default alias domain above and create an API key. Copy the
          key when it appears.
        </li>
        <li>
          In your password manager, choose the forwarded email alias generator
          with SimpleLogin as the service. In Bitwarden: Generator → Username →
          Forwarded email alias → SimpleLogin.
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
