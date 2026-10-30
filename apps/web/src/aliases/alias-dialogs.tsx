import * as React from "react";
import { Button } from "../ui/button.tsx";
import { Dialog, DialogContent } from "../ui/dialog.tsx";
import { TextField } from "../ui/text-field.tsx";
import { aliasesClient } from "./client.ts";
import type { AliasPageState } from "./use-alias-page.ts";

export function AliasCreateDialog({ state }: { state: AliasPageState }) {
  const { creating, busy, error, closeCreate, create } = state;
  return (
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
          <AliasCreateFields state={state} />
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
  );
}

function AliasCreateFields({ state }: { state: AliasPageState }) {
  return (
    <>
      <AliasAddressFields state={state} />
      <AliasDetailsFields state={state} />
    </>
  );
}

function AliasAddressFields({ state }: { state: AliasPageState }) {
  const { prefix, setPrefix, mode, setMode } = state;
  return (
    <>
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
    </>
  );
}

function AliasDetailsFields({ state }: { state: AliasPageState }) {
  const {
    domainId,
    setDomainId,
    website,
    setWebsite,
    note,
    setNote,
    domains,
    defaultDomain,
  } = state;
  return (
    <>
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
    </>
  );
}

export function AliasDeleteDialog({ state }: { state: AliasPageState }) {
  const { deleting, setDeleting, busy, error, setError, setNotice, run } =
    state;
  return (
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
  );
}
