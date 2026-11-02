import * as React from "react";
import { Button } from "../ui/button.tsx";
import { Dialog, DialogContent } from "../ui/dialog.tsx";
import { TextField } from "../ui/text-field.tsx";
import { aliasesClient } from "./client.ts";
import type { AliasPageState } from "./use-alias-page.ts";

export function ApiKeysPanel({ state }: { state: AliasPageState }) {
  const { setKeyDialog, busy, setError, notify, keys, run, keysHeading } =
    state;
  return (
    <section className="vault-card" aria-labelledby="alias-keys-heading">
      <div className="alias-section-heading">
        <div>
          <h2 id="alias-keys-heading" ref={keysHeading} tabIndex={-1}>
            Alias API keys
          </h2>
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
                  variant="ghost"
                  size="small"
                  className="alias-action alias-action-danger"
                  aria-disabled={busy}
                  aria-label={`Revoke ${key.name}`}
                  onClick={() => {
                    // The button goes away with the key's active state.
                    void run(
                      () => aliasesClient.revokeKey({ id: key.id }),
                      () =>
                        notify({ message: `API key “${key.name}” revoked.` }),
                      "notify",
                    ).then((done) => {
                      if (done) keysHeading.current?.focus();
                      return undefined;
                    });
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
  );
}

export function ApiKeyDialog({ state }: { state: AliasPageState }) {
  const {
    keyDialog,
    setKeyDialog,
    setKeyName,
    secret,
    setSecret,
    busy,
    setError,
  } = state;
  return (
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
        {secret ? <KeySecret state={state} /> : <KeyForm state={state} />}
      </DialogContent>
    </Dialog>
  );
}

function KeySecret({ state }: { state: AliasPageState }) {
  const { setKeyDialog, secret, setSecret, copy } = state;
  return (
    <div className="alias-form">
      <label>
        API key
        <textarea readOnly value={secret} rows={3} />
      </label>
      <Button
        variant="secondary"
        onClick={() => copy(secret, "API key copied to clipboard.")}
      >
        Copy API key
      </Button>
      <div className="dialog-actions">
        <Button
          onClick={() => {
            setKeyDialog(false);
            setSecret("");
          }}
        >
          Done
        </Button>
      </div>
    </div>
  );
}

function KeyForm({ state }: { state: AliasPageState }) {
  const { keyName, setKeyName, error, createKey, busy, setKeyDialog } = state;
  return (
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
  );
}
