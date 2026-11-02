import { ORPCError } from "@orpc/client";
import * as React from "react";
import { DriveCommandSchema, type DriveShare } from "@opensuite/contracts";
import { queryOptions, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useRef, useState, type FormEvent, type RefObject } from "react";
import { Button } from "../ui/button.tsx";
import { DialogContent } from "../ui/dialog.tsx";
import { TextField } from "../ui/text-field.tsx";
import { useToast } from "../ui/toast.tsx";
import { command } from "./client.ts";
import type { DriveEntry } from "./model.ts";
import { Links } from "./share-links.tsx";
import {
  attempt,
  nextRevoke,
  type Access,
  type AccessQuery,
  type FocusAfter,
  type Tools,
} from "./share-shared.ts";

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
  const addressRef = useRef<HTMLInputElement>(null);
  const tools: Tools = {
    entry,
    focusAfter,
    notify: (message) => notify({ message }),
    refresh: () =>
      queryClient.invalidateQueries({
        queryKey: sharesQuery(entry.id).queryKey,
      }),
    copy: (value, message) => {
      void Promise.resolve()
        .then(() => navigator.clipboard.writeText(value))
        .then(
          () => notify({ message }),
          () =>
            notify({
              message: "Could not copy. Select the text and copy it manually.",
            }),
        );
    },
  };
  return (
    <DialogContent
      title={`Share ${entry.name}`}
      description="Access applies to this item only, not to what is already inside it."
    >
      <ShareForm tools={tools} addressRef={addressRef} />
      <People tools={tools} query={query} addressRef={addressRef} />
      {entry.kind === "file" && <Links tools={tools} query={query} />}
    </DialogContent>
  );
}

function ShareForm({
  tools,
  addressRef,
}: {
  tools: Tools;
  addressRef: RefObject<HTMLInputElement | null>;
}) {
  const [address, setAddress] = useState("");
  const [access, setAccess] = useState<Access>("read");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const accessId = useId();
  async function share(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const recipient = address.trim();
    const input = DriveCommandSchema.safeParse({
      action: "share",
      id: tools.entry.id,
      address: recipient,
      access,
    });
    setError(
      input.success ? "" : "Enter an email address, such as name@example.org.",
    );
    if (input.success)
      await attempt(
        setBusy,
        async () => {
          await command(input.data);
          await tools.refresh();
          setAddress("");
          tools.notify(`Shared with ${recipient}.`);
        },
        (failure) => setError(shareError(failure)),
      );
    addressRef.current?.focus();
  }
  return (
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
        <label className="field-label" htmlFor={accessId}>
          Access
        </label>
        <select
          id={accessId}
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
  );
}

function People({
  tools,
  query,
  addressRef,
}: {
  tools: Tools;
  query: AccessQuery;
  addressRef: RefObject<HTMLInputElement | null>;
}) {
  const [busy, setBusy] = useState(false);
  const listRef = useRef<HTMLUListElement>(null);
  const headingId = useId();
  const shares = query.data?.shares ?? [];
  async function revoke(share: DriveShare) {
    tools.focusAfter(
      nextRevoke(listRef.current, share.id, () => addressRef.current),
    );
    await attempt(
      setBusy,
      async () => {
        await command({
          action: "unshare",
          id: tools.entry.id,
          shareId: share.id,
        });
        await tools.refresh();
        tools.notify(
          share.address
            ? `Access removed for ${share.address}.`
            : "Access removed.",
        );
      },
      () => tools.notify("Could not remove access. Try again."),
    );
  }
  return (
    <section className="drive-share-section" aria-labelledby={headingId}>
      <h3 id={headingId}>People with access</h3>
      {query.isPending ? (
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
      ) : shares.length === 0 ? (
        <p className="drive-share-empty">Only you have access.</p>
      ) : (
        <ul className="drive-share-list" ref={listRef}>
          {shares.map((share) => (
            <PersonRow
              key={share.id}
              share={share}
              busy={busy}
              tools={tools}
              onRevoke={() => {
                void revoke(share);
              }}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function PersonRow({
  share,
  busy,
  tools,
  onRevoke,
}: {
  share: DriveShare;
  busy: boolean;
  tools: Tools;
  onRevoke: () => void;
}) {
  const who = share.address;
  return (
    <li data-id={share.id}>
      <span className="drive-share-who">
        <strong>{who ?? "Unavailable account"}</strong>
        <small>{accessLabel[share.access]}</small>
      </span>
      {who !== null && (
        <Button
          variant="ghost"
          size="small"
          className="drive-copy"
          aria-label={`Copy ${who}`}
          onClick={() => tools.copy(who, "Address copied.")}
        >
          Copy
        </Button>
      )}
      <Button
        variant="secondary"
        size="small"
        className="drive-revoke"
        aria-label={`Remove access for ${who ?? "unavailable account"}`}
        disabled={busy}
        onClick={onRevoke}
      >
        Revoke
      </Button>
    </li>
  );
}
