import * as React from "react";
import type { DriveLink } from "@opensuite/contracts";
import { useId, useRef, useState, type RefObject } from "react";
import { Button } from "../ui/button.tsx";
import { command } from "./client.ts";
import {
  attempt,
  nextRevoke,
  type AccessQuery,
  type Tools,
} from "./share-shared.ts";

function publicUrl(token: string) {
  return `${window.location.origin}/drive/api/v1/public/${encodeURIComponent(token)}`;
}
function expiresAfter(days: number) {
  return new Date(Date.now() + days * 86_400_000).toISOString();
}
export function Links({ tools, query }: { tools: Tools; query: AccessQuery }) {
  const [days, setDays] = useState("7");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const listRef = useRef<HTMLUListElement>(null);
  const createRef = useRef<HTMLButtonElement>(null);
  const [issued, setIssued] = useState(new Map<string, string>());
  const links = query.data?.links ?? [];
  async function create() {
    const duration = Number(days);
    if (!Number.isInteger(duration) || duration < 1 || duration > 365) {
      setError("Choose an expiry between 1 and 365 days.");
      return;
    }
    setError("");
    await attempt(
      setBusy,
      async () => {
        const result = await command({
          action: "link",
          id: tools.entry.id,
          expiresAt: expiresAfter(duration),
        });
        if (!("token" in result)) throw new Error("Missing token");
        setIssued((current) => new Map(current).set(result.id, result.token));
        tools.focusAfter(
          () =>
            listRef.current?.querySelector<HTMLElement>(
              `li[data-id="${CSS.escape(result.id)}"] .drive-copy`,
            ) ?? null,
        );
        await tools.refresh();
        tools.notify("Public link created.");
      },
      () => setError("Could not create a public link. Try again."),
    );
  }
  async function revoke(id: string) {
    tools.focusAfter(nextRevoke(listRef.current, id, () => createRef.current));
    await attempt(
      setBusy,
      async () => {
        await command({ action: "unlink", id: tools.entry.id, linkId: id });
        await tools.refresh();
        tools.notify("Link revoked.");
      },
      () => tools.notify("Could not revoke the link. Try again."),
    );
  }
  return (
    <section className="drive-share-section" aria-label="Public links">
      <h3>Public links</h3>
      <p className="field-description">
        Anyone with an unexpired link can download this file.
      </p>
      <LinkCreator
        days={days}
        error={error}
        busy={busy}
        createRef={createRef}
        onDays={setDays}
        onCreate={() => {
          void create();
        }}
      />
      {query.isSuccess && (
        <LinkList
          links={links}
          issued={issued}
          listRef={listRef}
          busy={busy}
          tools={tools}
          onRevoke={(id) => {
            void revoke(id);
          }}
        />
      )}
    </section>
  );
}

function LinkList({
  links,
  issued,
  listRef,
  busy,
  tools,
  onRevoke,
}: {
  links: DriveLink[];
  issued: ReadonlyMap<string, string>;
  listRef: RefObject<HTMLUListElement | null>;
  busy: boolean;
  tools: Tools;
  onRevoke: (id: string) => void;
}) {
  if (links.length === 0)
    return <p className="drive-share-empty">No active links.</p>;
  return (
    <ul className="drive-share-list" ref={listRef}>
      {links.map((link) => {
        const expires = new Date(link.expiresAt).toLocaleString();
        const label = `Public link, expires ${expires}`;
        // Without a link key, the server shows a token only when it issues it.
        const token = link.token ?? issued.get(link.id);
        const url = token === undefined ? null : publicUrl(token);
        return (
          <li key={link.id} data-id={link.id}>
            {url === null ? (
              <span className="drive-share-who">
                <strong>Link created earlier</strong>
                <small>Expires {expires}. It can no longer be shown.</small>
              </span>
            ) : (
              <>
                <input
                  className="field-input drive-link-url"
                  readOnly
                  aria-label={label}
                  value={url}
                  onFocus={(event) => event.currentTarget.select()}
                />
                <Button
                  variant="ghost"
                  size="small"
                  className="drive-copy"
                  aria-label={`Copy ${label}`}
                  onClick={() => tools.copy(url, "Link copied.")}
                >
                  Copy
                </Button>
              </>
            )}
            <Button
              variant="secondary"
              size="small"
              className="drive-revoke"
              aria-label={`Revoke ${label}`}
              disabled={busy}
              onClick={() => onRevoke(link.id)}
            >
              Revoke
            </Button>
          </li>
        );
      })}
    </ul>
  );
}

function LinkCreator({
  days,
  error,
  busy,
  createRef,
  onDays,
  onCreate,
}: {
  days: string;
  error: string;
  busy: boolean;
  createRef: RefObject<HTMLButtonElement | null>;
  onDays: (days: string) => void;
  onCreate: () => void;
}) {
  const ids = useId();
  return (
    <>
      <div className="drive-link-create">
        <div className="field">
          <label className="field-label" htmlFor={`${ids}-expiry`}>
            Expires after (days)
          </label>
          <input
            id={`${ids}-expiry`}
            className="field-input"
            type="number"
            min="1"
            max="365"
            value={days}
            aria-invalid={Boolean(error)}
            aria-describedby={error ? `${ids}-error` : undefined}
            onChange={(event) => onDays(event.target.value)}
          />
        </div>
        <Button
          ref={createRef}
          variant="secondary"
          disabled={busy}
          onClick={onCreate}
        >
          Create link
        </Button>
      </div>
      {error && (
        <p className="field-error" id={`${ids}-error`}>
          {error}
        </p>
      )}
    </>
  );
}
