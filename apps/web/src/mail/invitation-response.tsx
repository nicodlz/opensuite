import * as React from "react";
import type { Calendar } from "@opensuite/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  accountId as calendarAccountId,
  calendarClient,
} from "../calendar/client.ts";
import { calendarsKey, eventsKey } from "../calendar/events.ts";
import { Button } from "../ui/button.tsx";
import { Dialog, DialogContent } from "../ui/dialog.tsx";
import { useToast } from "../ui/toast.tsx";
import { accountId, invitationsClient, mailKey } from "./client.ts";
import {
  checkableOperation,
  failureCode,
  nextAttempt,
  outcomeNotice,
  replyLabels,
  replyStates,
  type Attempt,
  type Choice,
  type Invitation,
  type InvitationEvent,
  type InvitationKind,
  type OperationResult,
  type Outcome,
  type Reply,
} from "./invitation-model.ts";

// Kept in the query cache, which sign-out and session expiry clear: the
// outcome per message, so the card shows it again after the reader changes,
// and the calendar that received a series, for its update or cancellation.
const outcomeKey = (messageId: string) => ["invitations", "outcome", messageId];
const calendarKey = (uid: string) => ["invitations", "calendar", uid];
const replies: Reply[] = ["accept", "tentative", "decline"];

const idle: Outcome = { step: "idle" };

/**
 * Sends a chosen response and follows its outcome; it never runs on its own.
 * The attempt is recorded before it is sent and its result is settled by the
 * mutation itself, so closing the card keeps the request ID, the result and
 * the Mail and Calendar refresh.
 */
function useResponder(
  messageId: string,
  invitation: Invitation,
  event: InvitationEvent,
  kind: InvitationKind,
) {
  const queryClient = useQueryClient();
  const { notify } = useToast();
  const { data: outcome = idle } = useQuery({
    queryKey: outcomeKey(messageId),
    queryFn: () => idle,
    enabled: false,
    gcTime: Infinity,
  });
  function record(next: Outcome, announce = true) {
    queryClient.setQueryData(outcomeKey(messageId), next);
    const notice = announce ? outcomeNotice(next, kind) : null;
    if (notice) notify({ message: notice.announce });
  }
  function settle(attempt: Attempt, result: OperationResult) {
    const { calendarId } = attempt.input;
    if (result.eventId !== null)
      queryClient.setQueryData(calendarKey(event.uid), calendarId);
    record({ step: "done", attempt, result });
    for (const part of ["thread", "threads", "mailboxes", "invitation"])
      void queryClient.invalidateQueries({ queryKey: [...mailKey, part] });
    void queryClient.invalidateQueries({ queryKey: eventsKey });
  }
  const respond = useMutation({
    mutationFn: ({ input, confirmed }: Attempt) =>
      confirmed
        ? invitationsClient.confirm(input)
        : invitationsClient.act(input),
    onSuccess: (result, attempt) => settle(attempt, result),
    onError: (error, attempt) =>
      record({ step: "failed", attempt, code: failureCode(error) }),
  });
  const reconcile = useMutation({
    mutationFn: ({ id }: { attempt: Attempt; id: string }) =>
      invitationsClient.reconcile({ accountId, operationId: id }),
    onSuccess: (result, { attempt }) => settle(attempt, result),
    onError: (error, { attempt }) =>
      record(
        failureCode(error) === "NOT_FOUND"
          ? { step: "unrecorded" }
          : { step: "unknown", attempt },
      ),
  });
  function start(action: Choice, confirmed: boolean, calendarId: string) {
    if (outcome.step === "working") return;
    const target = { accountId, messageId, calendarId };
    const attempt = nextAttempt(outcome, target, invitation, action, confirmed);
    record({ step: "working", attempt, checking: false }, false);
    respond.mutate(attempt);
  }
  function check() {
    const operation = checkableOperation(outcome);
    if (!operation) return;
    record(
      { step: "working", attempt: operation.attempt, checking: true },
      false,
    );
    reconcile.mutate(operation);
  }
  return { outcome, start, check, reset: () => record(idle) };
}

/** Puts focus back on the control that opened a dialog once it closes. */
function useReturnFocus(open: boolean) {
  const opener = useRef<Element | null>(null);
  useEffect(() => {
    if (open) return;
    const target = opener.current;
    opener.current = null;
    if (target instanceof HTMLElement && target.isConnected) target.focus();
  }, [open]);
  return () => {
    opener.current = document.activeElement;
  };
}

function useCalendarChoice(uid: string) {
  const queryClient = useQueryClient();
  const calendars = useQuery({
    queryKey: calendarsKey,
    queryFn: () => calendarClient.calendars({ accountId: calendarAccountId }),
    staleTime: 30_000,
  });
  const [picked, setPicked] = useState<string | null>(null);
  const list = calendars.data?.calendars ?? [];
  const known = (id: string | null | undefined) =>
    id && list.some((item) => item.id === id) ? id : undefined;
  const calendarId =
    known(picked) ??
    known(queryClient.getQueryData<string>(calendarKey(uid))) ??
    list.find((item) => item.isDefault)?.id ??
    list[0]?.id ??
    null;
  return { calendars, list, calendarId, setPicked };
}

function ConfirmUnverified({
  choice,
  organizer,
  kind,
  onCancel,
  onConfirm,
}: {
  choice: Reply | null;
  organizer: string;
  kind: InvitationKind;
  onCancel: () => void;
  onConfirm: (choice: Reply) => void;
}) {
  return (
    <Dialog
      open={choice !== null}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <DialogContent
        title="Respond to an unverified invitation?"
        description={`We couldn't verify that ${organizer} sent this invitation.`}
      >
        <p className="invite-dialog-text">
          {`If you continue, the event is added to your calendar and your response (${choice ? replyStates[choice] : ""}) is sent to that address. Only continue if you expected this invitation.`}
        </p>
        {kind === "update" && (
          <p className="invite-dialog-text">
            {
              "Unverified changes can't update an event that's already in your calendar."
            }
          </p>
        )}
        <div className="dialog-actions invite-dialog-actions">
          <Button variant="ghost" data-autofocus onClick={onCancel}>
            Cancel
          </Button>
          <Button
            variant="secondary"
            onClick={() => {
              if (choice) onConfirm(choice);
            }}
          >
            Respond anyway
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ResponseControls({
  kind,
  verified,
  calendars,
  calendarId,
  busy,
  chosen,
  onPick,
  onChoose,
}: {
  kind: InvitationKind;
  verified: boolean;
  calendars: Calendar[];
  calendarId: string | null;
  busy: boolean;
  chosen: Choice | null;
  onPick: (calendarId: string) => void;
  onChoose: (action: Choice) => void;
}) {
  const canReply = kind !== "cancel";
  const canApply = verified && kind !== "new";
  if (!canReply && !canApply) return null;
  const blocked = busy || calendarId === null;
  return (
    <div className="invite-controls">
      {calendars.length > 1 && (
        <label className="invite-calendar">
          <span>{kind === "new" ? "Add to calendar" : "Calendar"}</span>
          <select
            value={calendarId ?? ""}
            disabled={busy}
            onChange={(change) => onPick(change.target.value)}
          >
            {calendars.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {canReply && (
        <fieldset className="invite-replies" aria-busy={busy}>
          <legend className="visually-hidden">Your response</legend>
          {replies.map((action) => (
            <Button
              key={action}
              variant="ghost"
              className="invite-reply"
              aria-pressed={chosen === action}
              aria-disabled={blocked}
              onClick={() => onChoose(action)}
            >
              {replyLabels[action]}
            </Button>
          ))}
        </fieldset>
      )}
      {canApply && (
        <Button
          variant="ghost"
          className="invite-apply"
          aria-disabled={blocked}
          onClick={() => onChoose("apply")}
        >
          {kind === "cancel" ? "Remove from calendar" : "Update calendar"}
        </Button>
      )}
    </div>
  );
}

function ResponseStatus({
  outcome,
  kind,
  link,
  onCheck,
  onReload,
}: {
  outcome: Outcome;
  kind: InvitationKind;
  link: ReactNode;
  onCheck: () => void;
  onReload: () => void;
}) {
  const statusRef = useRef<HTMLParagraphElement>(null);
  const checked = useRef(false);
  useEffect(() => {
    // The Check status button is gone; keep keyboard focus in the card.
    if (!checked.current || outcome.step === "working") return;
    checked.current = false;
    if (document.activeElement === document.body) statusRef.current?.focus();
  }, [outcome]);
  const status = outcomeNotice(outcome, kind);
  return (
    <>
      {status && (
        <p
          ref={statusRef}
          tabIndex={-1}
          className="invite-status"
          data-tone={status.tone}
        >
          {status.text}
        </p>
      )}
      <div className="invite-followups">
        {checkableOperation(outcome) && (
          <Button
            variant="ghost"
            size="small"
            onClick={() => {
              checked.current = true;
              onCheck();
            }}
          >
            Check status
          </Button>
        )}
        {outcome.step === "failed" && outcome.code === "CONFLICT" && (
          <Button variant="ghost" size="small" onClick={onReload}>
            Reload invitation
          </Button>
        )}
        {link}
      </div>
    </>
  );
}

function CalendarsError({ onRetry }: { onRetry: () => void }) {
  return (
    <p className="invite-status" data-tone="danger">
      {"Your calendars couldn't be loaded, so you can't respond yet. "}
      <button type="button" className="link-button" onClick={onRetry}>
        Retry
      </button>
    </p>
  );
}

type ResponseProps = {
  messageId: string;
  invitation: Invitation;
  event: InvitationEvent;
  kind: InvitationKind;
  /** A link to the event in Calendar, once the service names it. */
  renderLink: (eventId: string | null) => ReactNode;
  onReload: () => void;
};
/** Response controls; nothing is sent until the user chooses an action. */
export function InvitationResponse(props: ResponseProps) {
  const { invitation, event, kind } = props;
  const verified = invitation.senderStatus === "verified";
  const { calendars, list, calendarId, setPicked } = useCalendarChoice(
    event.uid,
  );
  const responder = useResponder(props.messageId, invitation, event, kind);
  const [confirming, setConfirming] = useState<Reply | null>(null);
  const rememberOpener = useReturnFocus(confirming !== null);
  const { outcome } = responder;
  const busy = outcome.step === "working";
  const done =
    outcome.step === "done" && outcome.result.state !== "failed"
      ? outcome
      : null;
  function choose(action: Choice) {
    if (busy || calendarId === null) return;
    // An unverified sender needs an explicit confirmation, sent to its own endpoint.
    if (verified || action === "apply") {
      responder.start(action, false, calendarId);
      return;
    }
    rememberOpener();
    setConfirming(action);
  }
  return (
    <div className="invite-respond">
      <ResponseControls
        kind={kind}
        verified={verified}
        calendars={list}
        calendarId={calendarId}
        busy={busy}
        chosen={done ? done.attempt.input.action : null}
        onPick={setPicked}
        onChoose={choose}
      />
      {calendars.isError && (
        <CalendarsError onRetry={() => void calendars.refetch()} />
      )}
      <ResponseStatus
        outcome={outcome}
        kind={kind}
        link={props.renderLink(
          done && kind !== "cancel" ? done.result.eventId : null,
        )}
        onCheck={responder.check}
        onReload={() => {
          responder.reset();
          props.onReload();
        }}
      />
      <ConfirmUnverified
        choice={confirming}
        organizer={event.organizer.email}
        kind={kind}
        onCancel={() => setConfirming(null)}
        onConfirm={(choice) => {
          setConfirming(null);
          if (calendarId !== null) responder.start(choice, true, calendarId);
        }}
      />
    </div>
  );
}
