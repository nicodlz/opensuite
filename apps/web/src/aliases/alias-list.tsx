import * as React from "react";
import { useEffect, useRef, type RefObject } from "react";
import { Button } from "../ui/button.tsx";
import { Icon, type IconName } from "../ui/icons.tsx";
import type { Alias } from "./client.ts";
import {
  aliasStatus,
  aliasStatusDetail,
  filterAliases,
  type AliasStatus,
} from "./model.ts";
import type { AliasPageState, FocusRequest } from "./use-alias-page.ts";

const statusStyle: Record<
  AliasStatus,
  { label: string; icon: IconName; className: string }
> = {
  active: { label: "Active", icon: "check", className: "status-ok" },
  pending: { label: "Pending", icon: "clock", className: "status-loading" },
  disabled: {
    label: "Disabled",
    icon: "minus",
    className: "alias-status-disabled",
  },
  suspended: { label: "Suspended", icon: "junk", className: "status-error" },
};

export function AliasList({ state }: { state: AliasPageState }) {
  const { list, filter, search } = state;
  const heading = useRef<HTMLHeadingElement>(null);
  const rows = useRef<HTMLUListElement>(null);
  const all = list.data ?? [];
  const visible = filterAliases(all, filter).filter((alias) =>
    [alias.address, alias.website ?? "", alias.note ?? ""].some((value) =>
      value.toLowerCase().includes(search.trim().toLowerCase()),
    ),
  );
  useRestoreFocus(state, visible, rows, heading);
  return (
    <section className="vault-card" aria-labelledby="alias-list-heading">
      <h2
        id="alias-list-heading"
        className="alias-list-heading"
        ref={heading}
        tabIndex={-1}
      >
        Your aliases
      </h2>
      {list.isPending ? (
        <p>Loading aliases…</p>
      ) : all.length === 0 ? (
        <p>You have no aliases yet. Create one to keep your address private.</p>
      ) : (
        <>
          <AliasToolbar state={state} />
          {visible.length === 0 ? (
            <p>No aliases match this search and filter.</p>
          ) : (
            <ul className="alias-list" aria-label="Aliases" ref={rows}>
              {visible.map((alias, index) => (
                <AliasRow
                  key={alias.id}
                  state={state}
                  alias={alias}
                  index={index}
                />
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

/** Moves focus once the list shows the result of a create, toggle or delete. */
function useRestoreFocus(
  state: AliasPageState,
  visible: Alias[],
  rows: RefObject<HTMLUListElement | null>,
  heading: RefObject<HTMLHeadingElement | null>,
) {
  const { focusRequest, setFocusRequest, createButton } = state;
  useEffect(() => {
    if (!focusRequest) return;
    setFocusRequest(null);
    focusTarget(focusRequest, visible, rows.current, {
      create: createButton.current,
      heading: heading.current,
    })?.focus();
  }, [focusRequest, setFocusRequest, visible, rows, heading, createButton]);
}

function focusTarget(
  request: FocusRequest,
  visible: Alias[],
  rows: HTMLUListElement | null,
  fallback: { create: HTMLElement | null; heading: HTMLElement | null },
): HTMLElement | null {
  const alias =
    visible.find((item) => item.id === request.id) ??
    (request.fallback === "nearest"
      ? visible[Math.min(request.index, visible.length - 1)]
      : undefined);
  if (!alias)
    return request.fallback === "create" ? fallback.create : fallback.heading;
  return (
    rows?.querySelector<HTMLElement>(
      `[data-alias-id="${CSS.escape(alias.id)}"] [data-alias-control="${request.control}"]`,
    ) ?? fallback.heading
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

function AliasStatusBadge({ alias }: { alias: Alias }) {
  const style = statusStyle[aliasStatus(alias)];
  return (
    <div className="alias-status">
      <span className={`status-badge ${style.className}`}>
        <Icon name={style.icon} size={14} />
        {style.label}
      </span>
      <span className="alias-status-detail">{aliasStatusDetail(alias)}</span>
    </div>
  );
}

function AliasRow({
  state,
  alias,
  index,
}: {
  state: AliasPageState;
  alias: Alias;
  index: number;
}) {
  const { copy, busy, toggle, setError, setDeleting } = state;
  // Buttons stay focusable while a request runs, so focus is never dropped.
  return (
    <li
      className={`alias-row alias-row-${aliasStatus(alias)}`}
      data-alias-id={alias.id}
    >
      <div className="alias-details">
        <strong className="alias-address">{alias.address}</strong>
        <AliasStatusBadge alias={alias} />
        {alias.website && <p>Website: {alias.website}</p>}
        {alias.note && <p>{alias.note}</p>}
      </div>
      <div className="alias-actions">
        <Button
          variant="ghost"
          size="small"
          className="alias-action"
          data-alias-control="copy"
          onClick={() => copy(alias.address)}
          aria-label={`Copy ${alias.address}`}
        >
          Copy
        </Button>
        <Button
          variant="ghost"
          size="small"
          className="alias-action"
          data-alias-control="toggle"
          aria-disabled={busy}
          aria-label={`${alias.enabled ? "Disable" : "Enable"} ${alias.address}`}
          onClick={() => {
            void toggle(alias, index);
          }}
        >
          {alias.enabled ? "Disable" : "Enable"}
        </Button>
        <Button
          variant="ghost"
          size="small"
          className="alias-action alias-action-danger"
          data-alias-control="delete"
          aria-disabled={busy}
          aria-label={`Delete ${alias.address}`}
          onClick={() => {
            if (busy) return;
            setError("");
            setDeleting({ alias, index });
          }}
        >
          Delete
        </Button>
      </div>
    </li>
  );
}
