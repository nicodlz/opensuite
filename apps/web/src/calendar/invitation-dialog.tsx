import * as React from "react";
import { EventContentSchema, type CalendarEvent } from "@opensuite/contracts";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Button } from "../ui/button.tsx";
import { Dialog, DialogContent } from "../ui/dialog.tsx";
import { useToast, type ToastOptions } from "../ui/toast.tsx";
import { accountId, calendarClient } from "./client.ts";
import type { EventFocus } from "./event-focus.ts";
import { eventsKey, titleOf } from "./events.ts";
import { isRecurring, type EventTiming } from "./model.ts";
import { fetchStatus, useInvitationSend, type SendState } from "./organizer.ts";
import {
  failureNotice,
  guestsOf,
  isUncertain,
  planGroups,
  planInvitations,
  planWording,
  resultNotice,
  type InvitationRequest,
  type Notice,
  type OrganizerResult,
  type OrganizerStatus,
} from "./organizer-model.ts";

function noticeOf(request: InvitationRequest, state: SendState) {
  if (state.step === "done") return resultNotice(request.plan, state.result);
  if (state.step === "failed") return failureNotice(state.error);
  return null;
}

function Review({ request }: { request: InvitationRequest }) {
  return (
    <>
      {planWording(request.plan).notes.map((note) => (
        <p key={note} className="cal-invite-note">
          {note}
        </p>
      ))}
      <dl className="cal-invite-groups">
        {planGroups(request.plan).map((group) => (
          <div key={group.label}>
            <dt>
              {group.label} ({group.recipients.length})
            </dt>
            <dd>
              <ul>
                {group.recipients.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </dd>
          </div>
        ))}
      </dl>
    </>
  );
}

export function NoticeText({ notice }: { notice: Notice }) {
  return (
    <div
      className="cal-invite-notice"
      data-tone={notice.tone}
      role={notice.tone === "danger" ? "alert" : "status"}
    >
      <p>{notice.text}</p>
      {notice.details.length > 0 && (
        <ul>
          {notice.details.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

type Flow = {
  request: InvitationRequest;
  onBack: () => void;
  onResult: (result: OrganizerResult) => void;
  /** `unknown` when the last outcome could not be confirmed. */
  onClose: (unknown: boolean) => void;
};
type Send = ReturnType<typeof useInvitationSend>;
function ReviewActions({
  request,
  onBack,
  send,
}: Pick<Flow, "request" | "onBack"> & { send: Send }) {
  // Focus starts on the action, except for a cancellation: it can't be undone.
  const cancel = request.plan.kind === "cancel";
  return (
    <>
      <Button
        variant="ghost"
        data-autofocus={cancel || undefined}
        onClick={onBack}
      >
        {cancel ? "Keep event" : "Back"}
      </Button>
      <Button
        className={cancel ? "cal-danger" : undefined}
        data-autofocus={!cancel || undefined}
        onClick={() => send.send(request)}
      >
        {planWording(request.plan).action}
      </Button>
    </>
  );
}

function Actions({
  request,
  onBack,
  onClose,
  send,
}: Pick<Flow, "request" | "onBack"> & { onClose: () => void; send: Send }) {
  const { state } = send;
  if (state.step === "sending") return <Button disabled>Sending…</Button>;
  if (state.step === "review")
    return <ReviewActions request={request} onBack={onBack} send={send} />;
  const pending =
    state.step === "done" && state.result.state === "pending"
      ? state.result.operationId
      : null;
  const retry = state.step === "failed" && isUncertain(state.error);
  return (
    <>
      {state.step === "failed" && !retry && (
        <Button variant="ghost" onClick={onBack}>
          Back
        </Button>
      )}
      <Button
        variant={pending || retry ? "ghost" : "primary"}
        onClick={onClose}
      >
        Close
      </Button>
      {pending && (
        <Button onClick={() => send.check(pending)}>Check status</Button>
      )}
      {retry && <Button onClick={() => send.send(request)}>Try again</Button>}
    </>
  );
}

function InvitationFlow(flow: Flow) {
  const { request, onBack, onResult, onClose } = flow;
  const send = useInvitationSend(onResult);
  const actions = useRef<HTMLDivElement>(null);
  const { step } = send.state;
  // The pressed button is replaced while sending; focus its successor.
  useEffect(() => {
    if (step === "done" || step === "failed")
      actions.current?.querySelector<HTMLElement>("button:last-child")?.focus();
  }, [step]);
  const notice = noticeOf(request, send.state);
  const unknown = step === "failed" && isUncertain(send.state.error);
  const close = () => onClose(unknown);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (open || step === "sending") return;
        if (step === "done" || unknown) close();
        else onBack();
      }}
    >
      <DialogContent
        title={planWording(request.plan).title}
        description={`“${request.title}”`}
      >
        <div className="cal-invite">
          {notice ? (
            <NoticeText notice={notice} />
          ) : (
            <Review request={request} />
          )}
          <div className="dialog-actions cal-dialog-actions" ref={actions}>
            <Actions
              request={request}
              onBack={onBack}
              onClose={close}
              send={send}
            />
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

type Opened = {
  request: InvitationRequest;
  serial: number;
  after: (result: OrganizerResult) => void;
};
type Deps = {
  queryClient: QueryClient;
  notify: (options: ToastOptions) => void;
  focus: EventFocus;
};
const unknownText =
  "Esuno couldn't confirm the result of this change. Open the event in a moment to check its guests.";
const pendingText =
  "An earlier change to this event is still being sent to its guests. Open the event to check its status.";

/**
 * The guests of an event changed outside the editor: null when it has none,
 * undefined when the change must stop, which was then explained.
 */
async function guestsFor(deps: Deps, event: CalendarEvent, verb: string) {
  try {
    const status = await fetchStatus(deps.queryClient, event);
    if (status?.pendingOperationId) deps.notify({ message: pendingText });
    else if (status?.cancelled && verb === "moved")
      deps.notify({
        message: "This event was cancelled for its guests and can't be moved.",
      });
    else return status;
  } catch {
    deps.notify({
      message: `Calendar couldn't check this event's guests, so it wasn't ${verb}.`,
    });
  }
  return undefined;
}
/** The confirmation of a change that keeps the event's guests. */
function requestFor(
  event: CalendarEvent,
  status: OrganizerStatus,
  change: { timing?: EventTiming; cancel: boolean },
): InvitationRequest {
  const guests = guestsOf(status);
  const content = EventContentSchema.parse(event);
  return {
    title: titleOf(event),
    plan: planInvitations(guests, change.cancel ? [] : guests, {
      organizer: status.organizer,
      reset: !change.cancel,
      recurring: isRecurring(event),
      cancel: change.cancel,
    }),
    input: {
      accountId,
      eventId: event.id,
      organizer: status.organizer,
      attendees: guests,
      event: { ...content, ...change.timing },
      cancel: change.cancel,
    },
  };
}
/** A cancelled event leaves the calendar once its cancellation was handled. */
async function removeCancelled(deps: Deps, event: CalendarEvent) {
  try {
    await calendarClient.deleteEvent({ accountId, eventId: event.id });
    deps.focus.request({});
  } catch {
    deps.notify({
      message:
        "The event was cancelled for its guests but is still in your calendar. Delete it again to remove it.",
    });
  }
  await deps.queryClient.invalidateQueries({ queryKey: eventsKey });
}

/**
 * Changes of events with guests: the editor's, a moved event's and a
 * cancellation. Each is confirmed in a dialog listing who gets which
 * message, then sent once through the organizer service.
 */
export function useInvitations(focus: EventFocus, closeEditor: () => void) {
  const queryClient = useQueryClient();
  const { notify } = useToast();
  const deps: Deps = { queryClient, notify, focus };
  const [opened, setOpened] = useState<Opened | null>(null);
  const serial = useRef(0);
  function open(request: InvitationRequest, after: Opened["after"]) {
    serial.current += 1;
    setOpened({ request, after, serial: serial.current });
  }
  return {
    /** Confirms and sends the editor's change, then closes the editor. */
    review: (request: InvitationRequest) => {
      open(request, (result) => {
        closeEditor();
        const { start } = request.input.event;
        focus.request(
          result.eventId ? { seriesId: result.eventId, start } : {},
        );
      });
    },
    /** A moved event without guests continues with `plain`. */
    async move(event: CalendarEvent, timing: EventTiming, plain: () => void) {
      const status = await guestsFor(deps, event, "moved");
      if (status === null) plain();
      if (!status) return;
      open(requestFor(event, status, { timing, cancel: false }), () =>
        focus.request({ seriesId: event.seriesId, start: timing.start }),
      );
    },
    /** A deleted event without guests, or already cancelled, uses `plain`. */
    async remove(event: CalendarEvent, plain: () => void) {
      const status = await guestsFor(deps, event, "deleted");
      if (status === null || status?.cancelled) plain();
      if (!status || status.cancelled) return;
      open(requestFor(event, status, { cancel: true }), (result) => {
        if (result.state === "sent" || result.state === "failed")
          void removeCancelled(deps, event);
      });
    },
    dialog: opened && (
      <InvitationFlow
        key={opened.serial}
        request={opened.request}
        onBack={() => setOpened(null)}
        onClose={(unknown) => {
          setOpened(null);
          if (!unknown) return;
          // The change may have been made: never offer to send it afresh.
          closeEditor();
          notify({ message: unknownText });
          void queryClient.invalidateQueries({ queryKey: eventsKey });
        }}
        onResult={(result) => {
          opened.after(result);
          if (result.state !== "sent" || result.failedRecipients) return;
          setOpened(null);
          notify({ message: resultNotice(opened.request.plan, result).text });
        }}
      />
    ),
  };
}
