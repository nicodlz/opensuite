import * as React from "react";
import type { CalendarEvent, EventContent } from "@opensuite/contracts";
import { useMutation } from "@tanstack/react-query";
import { useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { invitationsClient } from "../mail/client.ts";
import { Button } from "../ui/button.tsx";
import { Icon } from "../ui/icons.tsx";
import { accountId } from "./client.ts";
import { isRecurring } from "./model.ts";
import { useGuestStatus, useSenders } from "./organizer.ts";
import { NoticeText } from "./invitation-dialog.tsx";
import {
  answerSummary,
  changesSchedule,
  checkNotice,
  guestAnswers,
  guestsOf,
  parseGuests,
  partstatLabel,
  planInvitations,
  sameContent,
  sameGuests,
  type GuestAnswer,
  type InvitationRequest,
} from "./organizer-model.ts";

/**
 * The editor's guest state. A new event may get guests; an existing one keeps
 * the guests the service knows, and one without guests stays without, since
 * invitations start when an event is created.
 */
export function useGuests(event: CalendarEvent | undefined) {
  const status = useGuestStatus(event);
  const senders = useSenders();
  const [edited, setEdited] = useState<string[] | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const check = useMutation({
    mutationFn: (operationId: string) =>
      invitationsClient.reconcileOrganized({ accountId, operationId }),
    onSettled: () => status.refetch(),
  });
  const data = status.data;
  const known = data ? guestsOf(data) : [];
  const mode =
    event === undefined
      ? "new"
      : data === undefined
        ? status.isError
          ? "error"
          : "loading"
        : data === null
          ? "plain"
          : data.cancelled
            ? "cancelled"
            : data.pendingOperationId
              ? "pending"
              : "organized";
  const sender = data
    ? data.organizer
    : picked !== null && senders.options.includes(picked)
      ? picked
      : (senders.options[0] ?? "");
  return {
    mode,
    status,
    senders,
    sender,
    known,
    list: edited ?? known,
    answers: data ? guestAnswers(data) : new Map<string, GuestAnswer>(),
    check,
    setList: setEdited,
    pick: setPicked,
  };
}
export type Guests = ReturnType<typeof useGuests>;

/** Why the editor cannot save right now, if it cannot. */
export function saveBlock(guests: Guests) {
  const { mode, list, sender, senders } = guests;
  if (mode === "loading") return "Loading guests…";
  if (mode === "error") return "Guests couldn't be loaded.";
  if (mode === "cancelled") return "This event was cancelled.";
  if (mode === "pending") return "An earlier change is still being sent.";
  if (mode === "new" && list.length > 0 && !sender)
    return senders.failed
      ? "Your sending addresses couldn't be loaded."
      : "Loading your sending addresses…";
  return "";
}

/**
 * The confirmation an edited event needs: "plain" when it has no guests,
 * "unchanged" when nothing would be sent.
 */
export function invitationFor(
  guests: Guests,
  event: CalendarEvent | undefined,
  before: EventContent,
  after: EventContent,
): InvitationRequest | "plain" | "unchanged" {
  const { mode, list, known, sender } = guests;
  if (mode === "plain" || (mode === "new" && list.length === 0)) return "plain";
  if (mode !== "new" && sameContent(before, after) && sameGuests(known, list))
    return "unchanged";
  const options = {
    organizer: sender,
    reset: mode !== "new" && changesSchedule(before, after),
    recurring:
      after.recurrence !== "none" || (event ? isRecurring(event) : false),
  };
  return {
    title: after.title || "(No title)",
    plan: planInvitations(mode === "new" ? null : known, list, options),
    input: {
      accountId,
      eventId: event?.id ?? null,
      organizer: sender,
      attendees: list,
      // Events with guests have no reminders yet; the service refuses them.
      event: { ...after, reminder: mode === "new" ? "none" : before.reminder },
      cancel: false,
    },
  };
}

function GuestRow({
  email,
  answer,
  isNew,
  onRemove,
}: {
  email: string;
  answer: GuestAnswer | undefined;
  isNew: boolean;
  onRemove: (() => void) | null;
}) {
  const label = isNew
    ? "Will be invited"
    : answer
      ? partstatLabel(answer.series ?? "NEEDS-ACTION")
      : null;
  return (
    <li className="cal-guest">
      <span className="cal-guest-address">{email}</span>
      {label && (
        <span className="cal-guest-answer" data-answer={answer?.series ?? ""}>
          {label}
        </span>
      )}
      {answer?.occurrences.map((item) => (
        <span key={item.label} className="cal-guest-occurrence">
          {partstatLabel(item.partstat)} on {item.label}
        </span>
      ))}
      {onRemove && (
        <button
          type="button"
          className="cal-icon-button cal-guest-remove"
          aria-label={`Remove ${email}`}
          title="Remove"
          onClick={onRemove}
        >
          <Icon name="close" size={16} />
        </button>
      )}
    </li>
  );
}

function AddGuests({
  guests,
  input,
}: {
  guests: Guests;
  input: RefObject<HTMLInputElement | null>;
}) {
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  function add() {
    const parsed = parseGuests(text, guests.list, guests.sender);
    setError(parsed.error);
    if (parsed.added.length) guests.setList([...guests.list, ...parsed.added]);
    if (!parsed.error) setText("");
  }
  function key(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key !== "Enter" || event.ctrlKey || event.metaKey) return;
    event.preventDefault();
    add();
  }
  return (
    <>
      <div className="cal-guest-add">
        <input
          ref={input}
          type="text"
          inputMode="email"
          autoComplete="email"
          className="field-input"
          aria-label="Add guests"
          placeholder="Add guests by email"
          aria-invalid={Boolean(error)}
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            setError("");
          }}
          onKeyDown={key}
        />
        <Button type="button" variant="secondary" onClick={add}>
          Add
        </Button>
      </div>
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
    </>
  );
}

function Sender({ guests }: { guests: Guests }) {
  const { mode, senders, sender } = guests;
  if (mode !== "new")
    return (
      <p className="cal-guests-note">
        Organizer: {sender}
        {!senders.loading && !senders.options.includes(sender) && (
          <>
            {" "}
            (you can no longer send from this address, so changes will be
            refused)
          </>
        )}
      </p>
    );
  return (
    <>
      <label className="field">
        <span className="field-label">Send invitations from</span>
        <select
          className="field-input"
          value={sender}
          disabled={senders.options.length === 0}
          onChange={(event) => guests.pick(event.target.value)}
        >
          {senders.options.map((item) => (
            <option key={item} value={item}>
              {item}
            </option>
          ))}
        </select>
      </label>
      {senders.failed && (
        <div className="cal-guests-status" role="alert">
          <p>{"Your sending addresses couldn't be loaded."}</p>
          <Button type="button" size="small" onClick={senders.retry}>
            Retry
          </Button>
        </div>
      )}
    </>
  );
}

function StatusLine({ guests }: { guests: Guests }) {
  const { status, answers, mode, check } = guests;
  const pending = status.data?.pendingOperationId;
  const checked = new Date(status.dataUpdatedAt).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
  return (
    <div className="cal-guests-status">
      {mode === "cancelled" && (
        <p>
          {
            "This event was cancelled and its guests were sent a cancellation. It can't be changed."
          }
        </p>
      )}
      {pending && (
        <output>
          An earlier change is still being sent to the guests.{" "}
          {check.isError && "Its status couldn't be checked."}
        </output>
      )}
      {check.data && <NoticeText notice={checkNotice(check.data)} />}
      <output className="cal-guests-summary">{answerSummary(answers)}</output>
      <p className="cal-guests-note">
        {status.isError
          ? "Answers couldn't be refreshed."
          : `Answers checked at ${checked}.`}
      </p>
      <div className="cal-guests-tools">
        {pending && (
          <Button
            type="button"
            size="small"
            disabled={check.isPending}
            onClick={() => check.mutate(pending)}
          >
            Check status
          </Button>
        )}
        <Button
          type="button"
          size="small"
          variant="ghost"
          disabled={status.isFetching}
          onClick={() => void status.refetch()}
        >
          {status.isFetching ? "Refreshing…" : "Refresh answers"}
        </Button>
      </div>
    </div>
  );
}

/** Guests of the event being edited, with their answers. */
export function GuestsField({ guests }: { guests: Guests }) {
  const { mode, list, known, answers } = guests;
  const editable = mode === "new" || mode === "organized";
  const removed = known.filter((item) => !list.includes(item));
  const input = useRef<HTMLInputElement>(null);
  // The removed row takes its button along; typing continues in the field.
  const remove = (email: string) => {
    guests.setList(list.filter((item) => item !== email));
    input.current?.focus();
  };
  return (
    <fieldset className="cal-guests">
      <legend className="field-label">Guests</legend>
      {mode === "plain" && (
        <p className="cal-guests-note">
          Guests are invited when an event is created. To invite people, create
          a new event with them.
        </p>
      )}
      {mode === "loading" && <p className="cal-guests-note">Loading guests…</p>}
      {mode === "error" && (
        <div className="cal-guests-status" role="alert">
          <p>
            {
              "This event's guests couldn't be loaded, so it can't be saved yet."
            }
          </p>
          <Button
            type="button"
            size="small"
            onClick={() => void guests.status.refetch()}
          >
            Retry
          </Button>
        </div>
      )}
      {!["plain", "loading", "error"].includes(mode) && (
        <Sender guests={guests} />
      )}
      {editable && <AddGuests guests={guests} input={input} />}
      {list.length > 0 && (
        <ul className="cal-guest-list" aria-label="Guest list">
          {list.map((email) => (
            <GuestRow
              key={email}
              email={email}
              answer={answers.get(email)}
              isNew={mode === "organized" && !known.includes(email)}
              onRemove={editable ? () => remove(email) : null}
            />
          ))}
        </ul>
      )}
      {removed.length > 0 && (
        <p className="cal-guests-note">
          Removed, will get a cancellation: {removed.join(", ")}
        </p>
      )}
      {mode !== "new" && guests.status.data && <StatusLine guests={guests} />}
    </fieldset>
  );
}
