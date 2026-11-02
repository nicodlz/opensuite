import { ORPCError } from "@orpc/client";
import * as React from "react";
import { DriveCommandSchema } from "@opensuite/contracts";
import { queryOptions, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useRef, useState, type FormEvent } from "react";
import { Button } from "../ui/button.tsx";
import { DialogContent } from "../ui/dialog.tsx";
import { TextField } from "../ui/text-field.tsx";
import { useToast } from "../ui/toast.tsx";
import { command } from "./client.ts";
import type { DriveEntry } from "./model.ts";

type Access = "read" | "write";
type FocusAfter = (target: () => HTMLElement | null) => void;

const accessLabel: Record<Access, string> = {
  read: "Can view",
  write: "Can edit",
};

function sharesQuery(id: string) {
  return queryOptions({
    queryKey: ["drive", "shares", id],
    queryFn: async () => {
      const result = await command({ action: "shares", id });
      if (!("shares" in result)) throw new Error("Unexpected Drive response");
      return result;
    },
  });
}
function publicUrl(token: string) {
  return `${window.location.origin}/drive/api/v1/public/${encodeURIComponent(token)}`;
}
function expiresAfter(days: number) {
  return new Date(Date.now() + days * 86_400_000).toISOString();
}
function shareError(error: unknown) {
  if (!(error instanceof ORPCError))
    return "Could not share this item. Try again.";
  switch (error.code) {
    case "RECIPIENT_NOT_FOUND":
      return "No account on this server uses this address.";
    case "TOO_MANY_REQUESTS":
      return "Too many sharing attempts. Try again later.";
    case "SERVICE_UNAVAILABLE":
      return "Sharing is temporarily unavailable. Try again later.";
    case "BAD_REQUEST":
      return error.message;
    default:
      return "Could not share this item. Check access and try again.";
  }
}

// After a revocation, focus moves to the same button of the next row, else
// to the control that adds to that list.
function nextRevoke(
  list: HTMLUListElement | null,
  id: string,
  fallback: () => HTMLElement | null,
) {
  const rows = [...(list?.querySelectorAll<HTMLElement>("li[data-id]") ?? [])];
  const index = rows.findIndex((row) => row.dataset["id"] === id);
  const next = rows[index + 1] ?? rows[index - 1];
  const nextId = next?.dataset["id"];
  return () =>
    (nextId === undefined
      ? null
      : list?.querySelector<HTMLElement>(
          `li[data-id="${CSS.escape(nextId)}"] .drive-revoke`,
        )) ?? fallback();
}

/**
 * People and public links with access to `entry`. Each row has its own Copy
 * and Revoke buttons, so nothing has to be typed again to manage access.
 */
export function ShareDialog({
  entry,
  focusAfter,
}: {
  entry: DriveEntry;
  focusAfter: FocusAfter;
}) {
  const queryClient = useQueryClient();
  const { notify } = useToast();
  const query = useQuery(sharesQuery(entry.id));
  const [address, setAddress] = useState("");
  const [access, setAccess] = useState<Access>("read");
  const [days, setDays] = useState("7");
  const [error, setError] = useState("");
  const [linkError, setLinkError] = useState("");
  const [busy, setBusy] = useState(false);
  const peopleRef = useRef<HTMLUListElement>(null);
  const linksRef = useRef<HTMLUListElement>(null);
  const addressRef = useRef<HTMLInputElement>(null);
  const createRef = useRef<HTMLButtonElement>(null);
  const ids = useId();
  const shares = query.data?.shares ?? [];
  const links = query.data?.links ?? [];

  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: sharesQuery(entry.id).queryKey });
  function copy(value: string, message: string) {
    void Promise.resolve()
      .then(() => navigator.clipboard.writeText(value))
      .then(
        () => notify({ message }),
        () =>
          notify({
            message: "Could not copy. Select the text and copy it manually.",
          }),
      );
  }
  async function share(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const input = DriveCommandSchema.safeParse({
      action: "share",
      id: entry.id,
      address: address.trim(),
      access,
    });
    if (!input.success) {
      setError("Enter an email address, such as name@example.org.");
      addressRef.current?.focus();
      return;
    }
    setBusy(true);
    setError("");
    try {
      await command(input.data);
      await refresh();
      setAddress("");
      notify({ message: `Shared with ${address.trim()}.` });
      addressRef.current?.focus();
    } catch (failure) {
      setError(shareError(failure));
      addressRef.current?.focus();
    } finally {
      setBusy(false);
    }
  }
  async function revokeShare(id: string, who: string | null) {
    focusAfter(nextRevoke(peopleRef.current, id, () => addressRef.current));
    setBusy(true);
    try {
      await command({ action: "unshare", id: entry.id, shareId: id });
      await refresh();
      notify({
        message: who ? `Access removed for ${who}.` : "Access removed.",
      });
    } catch {
      notify({ message: "Could not remove access. Try again." });
    } finally {
      setBusy(false);
    }
  }
  async function createLink() {
    const duration = Number(days);
    if (!Number.isInteger(duration) || duration < 1 || duration > 365) {
      setLinkError("Choose an expiry between 1 and 365 days.");
      return;
    }
    setBusy(true);
    setLinkError("");
    try {
      const result = await command({
        action: "link",
        id: entry.id,
        expiresAt: expiresAfter(duration),
      });
      if (!("token" in result)) throw new Error("Missing token");
      focusAfter(
        () =>
          linksRef.current?.querySelector<HTMLElement>(
            `li[data-id="${CSS.escape(result.id)}"] .drive-copy`,
          ) ?? null,
      );
      await refresh();
      notify({ message: "Public link created." });
    } catch {
      setLinkError("Could not create a public link. Try again.");
    } finally {
      setBusy(false);
    }
  }
  async function revokeLink(id: string) {
    focusAfter(nextRevoke(linksRef.current, id, () => createRef.current));
    setBusy(true);
    try {
      await command({ action: "unlink", id: entry.id, linkId: id });
      await refresh();
      notify({ message: "Link revoked." });
    } catch {
      notify({ message: "Could not revoke the link. Try again." });
    } finally {
      setBusy(false);
    }
  }

  const listState = query.isPending ? (
    <p className="drive-share-empty">Loading access…</p>
  ) : query.isError ? (
    <div className="drive-share-empty" role="alert">
      <p>Could not load who has access.</p>
      <Button
        variant="secondary"
        size="small"
        onClick={() => {
          void query.refetch();
        }}
      >
        Retry
      </Button>
    </div>
  ) : null;

  return (
    <DialogContent
      title={`Share ${entry.name}`}
      description="Access applies to this item only, not to what is already inside it."
    >
      <form
        className="drive-share-form"
        noValidate
        onSubmit={(event) => {
          void share(event);
        }}
      >
        <TextField
          ref={addressRef}
          label="Email address"
          type="email"
          autoComplete="off"
          spellCheck={false}
          value={address}
          error={error}
          onChange={(event) => setAddress(event.target.value)}
        />
        <div className="field">
          <label className="field-label" htmlFor={`${ids}-access`}>
            Access
          </label>
          <select
            id={`${ids}-access`}
            className="field-input"
            value={access}
            onChange={(event) =>
              setAccess(event.target.value === "write" ? "write" : "read")
            }
          >
            <option value="read">{accessLabel.read}</option>
            <option value="write">{accessLabel.write}</option>
          </select>
        </div>
        <Button type="submit" disabled={busy}>
          Share
        </Button>
      </form>
      <section
        className="drive-share-section"
        aria-labelledby={`${ids}-people`}
      >
        <h3 id={`${ids}-people`}>People with access</h3>
        {listState ??
          (shares.length === 0 ? (
            <p className="drive-share-empty">Only you have access.</p>
          ) : (
            <ul className="drive-share-list" ref={peopleRef}>
              {shares.map((item) => (
                <li key={item.id} data-id={item.id}>
                  <span className="drive-share-who">
                    <strong>{item.address ?? "Unavailable account"}</strong>
                    <small>{accessLabel[item.access]}</small>
                  </span>
                  {item.address && (
                    <Button
                      variant="ghost"
                      size="small"
                      className="drive-copy"
                      aria-label={`Copy ${item.address}`}
                      onClick={() =>
                        copy(item.address ?? "", "Address copied.")
                      }
                    >
                      Copy
                    </Button>
                  )}
                  <Button
                    variant="secondary"
                    size="small"
                    className="drive-revoke"
                    aria-label={`Remove access for ${item.address ?? "unavailable account"}`}
                    disabled={busy}
                    onClick={() => {
                      void revokeShare(item.id, item.address);
                    }}
                  >
                    Revoke
                  </Button>
                </li>
              ))}
            </ul>
          ))}
      </section>
      {entry.kind === "file" && (
        <section
          className="drive-share-section"
          aria-labelledby={`${ids}-links`}
        >
          <h3 id={`${ids}-links`}>Public links</h3>
          <p className="field-description">
            Anyone with an unexpired link can download this file.
          </p>
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
                aria-invalid={Boolean(linkError)}
                aria-describedby={linkError ? `${ids}-link-error` : undefined}
                onChange={(event) => setDays(event.target.value)}
              />
            </div>
            <Button
              ref={createRef}
              variant="secondary"
              disabled={busy}
              onClick={() => {
                void createLink();
              }}
            >
              Create link
            </Button>
          </div>
          {linkError && (
            <p className="field-error" id={`${ids}-link-error`}>
              {linkError}
            </p>
          )}
          {query.isSuccess &&
            (links.length === 0 ? (
              <p className="drive-share-empty">No active links.</p>
            ) : (
              <ul className="drive-share-list" ref={linksRef}>
                {links.map((link) => {
                  const expires = new Date(link.expiresAt).toLocaleString();
                  const label = `Public link, expires ${expires}`;
                  return (
                    <li key={link.id} data-id={link.id}>
                      {link.token === null ? (
                        <span className="drive-share-who">
                          <strong>Link created earlier</strong>
                          <small>
                            Expires {expires}. It can no longer be shown.
                          </small>
                        </span>
                      ) : (
                        <>
                          <input
                            className="field-input drive-link-url"
                            readOnly
                            aria-label={label}
                            value={publicUrl(link.token)}
                            onFocus={(event) => event.currentTarget.select()}
                          />
                          <Button
                            variant="ghost"
                            size="small"
                            className="drive-copy"
                            aria-label={`Copy ${label}`}
                            onClick={() =>
                              copy(publicUrl(link.token ?? ""), "Link copied.")
                            }
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
                        onClick={() => {
                          void revokeLink(link.id);
                        }}
                      >
                        Revoke
                      </Button>
                    </li>
                  );
                })}
              </ul>
            ))}
        </section>
      )}
    </DialogContent>
  );
}
