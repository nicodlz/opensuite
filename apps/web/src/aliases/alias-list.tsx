import * as React from "react";
import { Button } from "../ui/button.tsx";
import { aliasesClient, type Alias } from "./client.ts";
import { aliasState, filterAliases } from "./model.ts";
import type { AliasPageState } from "./use-alias-page.ts";

export function AliasList({ state }: { state: AliasPageState }) {
  const { list, filter, search } = state;
  const visible = filterAliases(list.data ?? [], filter).filter((alias) =>
    [alias.address, alias.website ?? "", alias.note ?? ""].some((value) =>
      value.toLowerCase().includes(search.trim().toLowerCase()),
    ),
  );
  return (
    <section className="vault-card">
      <AliasToolbar state={state} />
      <AliasRows state={state} visible={visible} />
    </section>
  );
}

function AliasToolbar({ state }: { state: AliasPageState }) {
  const { search, setSearch, filter, setFilter } = state;
  return (
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
  );
}

function AliasRows({
  state,
  visible,
}: {
  state: AliasPageState;
  visible: Alias[];
}) {
  const { list } = state;
  return (
    <>
      {list.isPending ? (
        <p>Loading aliases…</p>
      ) : visible.length === 0 ? (
        <p>No aliases found.</p>
      ) : (
        <ul className="alias-list" aria-label="Aliases">
          {visible.map((alias) => (
            <AliasRow key={alias.id} state={state} alias={alias} />
          ))}
        </ul>
      )}
    </>
  );
}

function AliasRow({ state, alias }: { state: AliasPageState; alias: Alias }) {
  const { copy, busy, run, setNotice, setError, setDeleting } = state;
  return (
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
                setNotice(alias.enabled ? "Alias disabled." : "Alias enabled."),
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
  );
}
