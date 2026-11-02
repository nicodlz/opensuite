import * as React from "react";
import type { Message } from "@opensuite/contracts";
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { formatEventRange, timeZoneLabel } from "../calendar/model.ts";
import { activeLayout, isExternal, productHref } from "../origins.ts";
import { Button } from "../ui/button.tsx";
import { Icon } from "../ui/icons.tsx";
import { accountId, invitationsClient, mailClient, mailKey } from "./client.ts";
import {
  eventTiming,
  failureCode,
  invitationKind,
  kindLabels,
  participation,
  primaryEvent,
  repeatLabel,
  safeLink,
  unverifiedTexts,
  zoneNote,
  type Invitation,
  type InvitationEvent,
  type InvitationKind,
  type Timing,
} from "./invitation-model.ts";
import { InvitationResponse } from "./invitation-response.tsx";

const shownGuests = 6;

/** Opens Calendar on the event's day, and on the event itself once it exists. */
function CalendarLink({
  timing,
  eventId,
}: {
  timing: Timing | null;
  eventId: string | null;
}) {
  const router = useRouter();
  if (!timing?.known) return null;
  const params = new URLSearchParams(
    eventId === null ? {} : { event: eventId },
  );
  params.set("start", timing.start);
  if (timing.allDay) {
    params.set("allDay", "1");
    params.set("day", timing.start.slice(0, 10));
  }
  const href = `${productHref(activeLayout(), "calendar")}?${params.toString()}`;
  return (
    <a
      className="invite-link"
      href={href}
      onClick={(click) => {
        if (
          isExternal(href) ||
          click.button !== 0 ||
          click.metaKey ||
          click.ctrlKey ||
          click.shiftKey ||
          click.altKey
        )
          return;
        // An in-app move keeps this tab's cached data.
        click.preventDefault();
        void router.navigate({ href });
      }}
    >
      <Icon name="calendar" size={16} />
      Open in Calendar
    </a>
  );
}

function Guests({ event }: { event: InvitationEvent }) {
  const [all, setAll] = useState(false);
  const identity = useQuery({
    queryKey: [...mailKey, "identity"],
    queryFn: () => mailClient.identity({ accountId }),
    staleTime: Infinity,
  });
  const self = identity.data?.address.email.toLowerCase();
  const guests = event.attendees.filter(
    (guest, index, list) =>
      list.findIndex((item) => item.email === guest.email) === index,
  );
  return (
    <>
      <ul className="invite-guests">
        {(all ? guests : guests.slice(0, shownGuests)).map((guest) => (
          <li key={guest.email}>
            <bdi>{guest.name ?? guest.email}</bdi>
            {guest.email.toLowerCase() === self && " (you)"}
            {guest.name !== null && (
              <span className="invite-muted">
                {" "}
                <bdi>{guest.email}</bdi>
              </span>
            )}
            {participation[guest.partstat] !== undefined && (
              <span className="invite-partstat" data-partstat={guest.partstat}>
                {participation[guest.partstat]}
              </span>
            )}
          </li>
        ))}
      </ul>
      {guests.length > shownGuests && (
        <button
          type="button"
          className="link-button invite-more"
          aria-expanded={all}
          onClick={() => setAll(!all)}
        >
          {all
            ? "Show fewer guests"
            : `Show all ${String(guests.length)} guests`}
        </button>
      )}
    </>
  );
}

function When({
  timing,
  kind,
  event,
  others,
}: {
  timing: Timing;
  kind: InvitationKind;
  event: InvitationEvent;
  others: number;
}) {
  const cancelled = kind === "cancel" ? "invite-cancelled" : undefined;
  const note = timing.known ? zoneNote(timing) : null;
  return (
    <dd>
      {timing.known ? (
        <>
          <time dateTime={timing.start} className={cancelled}>
            {formatEventRange(timing)}
          </time>
          <span className="invite-muted">
            {timing.allDay
              ? " · All day"
              : ` (${timeZoneLabel(new Date(timing.start))})`}
          </span>
        </>
      ) : (
        <span className={cancelled}>{timing.text}</span>
      )}
      {!timing.known && (
        <span className="invite-muted invite-note">
          {"This time zone isn't recognized; the time is shown as written."}
        </span>
      )}
      {note && (
        <span className="invite-muted invite-note">Event time: {note}</span>
      )}
      {event.recurrenceId !== null && (
        <span className="invite-muted invite-note">
          One occurrence of a repeating event.
        </span>
      )}
      {others > 0 && (
        <span className="invite-muted invite-note">
          {`Also changes ${others === 1 ? "1 other occurrence" : `${String(others)} other occurrences`}.`}
        </span>
      )}
    </dd>
  );
}

/** A meeting link is shown with its real address; it stays untrusted content. */
function MeetingLink({ url, verified }: { url: URL; verified: boolean }) {
  return (
    <dd>
      <a
        className="invite-link"
        href={url.href}
        target="_blank"
        rel="noopener noreferrer"
        referrerPolicy="no-referrer"
      >
        {verified ? "Join meeting" : "Open link"}{" "}
        <span className="invite-host">
          {url.host}
          {url.pathname === "/" ? "" : url.pathname}
        </span>
      </a>
      {!verified && (
        <span className="invite-muted invite-note">
          Check this address before opening it.
        </span>
      )}
    </dd>
  );
}

function Details({
  invitation,
  event,
  kind,
  timing,
}: {
  invitation: Invitation;
  event: InvitationEvent;
  kind: InvitationKind;
  timing: Timing | null;
}) {
  const verified = invitation.senderStatus === "verified";
  const link = safeLink(event.meetingUrl);
  const repeats = repeatLabel(event.recurrence);
  const { organizer } = event;
  return (
    <dl className="invite-details">
      {timing && (
        <div>
          <dt>When</dt>
          <When
            timing={timing}
            kind={kind}
            event={event}
            others={invitation.events.length - 1}
          />
        </div>
      )}
      {repeats && (
        <div>
          <dt>Repeats</dt>
          <dd>{repeats}</dd>
        </div>
      )}
      {event.location.trim() && (
        <div>
          <dt>Where</dt>
          <dd dir="auto">{event.location}</dd>
        </div>
      )}
      {link && (
        <div>
          <dt>Meeting</dt>
          <MeetingLink url={link} verified={verified} />
        </div>
      )}
      <div>
        <dt>Organizer</dt>
        <dd>
          <bdi>{organizer.name ?? organizer.email}</bdi>
          {organizer.name !== null && (
            <span className="invite-muted">
              {" "}
              <bdi>{organizer.email}</bdi>
            </span>
          )}
        </dd>
      </div>
      {event.attendees.length > 0 && (
        <div>
          <dt>Guests</dt>
          <dd>
            <Guests event={event} />
          </dd>
        </div>
      )}
    </dl>
  );
}

function InvitationDetails({
  messageId,
  invitation,
  event,
  onReload,
}: {
  messageId: string;
  invitation: Invitation;
  event: InvitationEvent;
  onReload: () => void;
}) {
  const kind = invitationKind(invitation);
  const verified = invitation.senderStatus === "verified";
  const timing = eventTiming(event);
  const title = event.title.trim() || "(No title)";
  return (
    <section
      className="invite-card"
      data-kind={kind}
      data-sender={invitation.senderStatus}
      aria-label={`${kindLabels[kind]}: ${title}`}
    >
      <header className="invite-head">
        <span className="invite-kind">{kindLabels[kind]}</span>
        <span className="invite-sender" data-sender={invitation.senderStatus}>
          {verified && <Icon name="check" size={14} />}
          {verified ? "Verified organizer" : "Unverified sender"}
        </span>
        <h3 dir="auto">{title}</h3>
      </header>
      {!verified && (
        <div className="invite-warning" role="note">
          <strong>Sender not verified</strong>
          <p>{unverifiedTexts[kind](event.organizer.email)}</p>
        </div>
      )}
      <Details
        invitation={invitation}
        event={event}
        kind={kind}
        timing={timing}
      />
      {event.description.trim() && (
        <details className="invite-description">
          <summary>Description</summary>
          <p dir="auto">{event.description.slice(0, 5000)}</p>
        </details>
      )}
      <InvitationResponse
        messageId={messageId}
        invitation={invitation}
        event={event}
        kind={kind}
        renderLink={(eventId) => (
          <CalendarLink timing={timing} eventId={eventId} />
        )}
        onReload={onReload}
      />
    </section>
  );
}

/** The invitation in `message`. Reading it never sends a response. */
export function InvitationCard({ message }: { message: Message }) {
  const query = useQuery({
    queryKey: [...mailKey, "invitation", message.id],
    queryFn: () => invitationsClient.read({ accountId, messageId: message.id }),
    staleTime: 60_000,
  });
  const invitation = query.data;
  const event = invitation && primaryEvent(invitation);
  if (invitation && event)
    return (
      <InvitationDetails
        messageId={message.id}
        invitation={invitation}
        event={event}
        onReload={() => {
          void query.refetch();
        }}
      />
    );
  // A reply, another method or an unreadable calendar part is not an invitation.
  const code = query.isError ? failureCode(query.error) : null;
  if (invitation || code === "VALIDATION" || code === "NOT_FOUND") return null;
  if (code)
    return (
      <div className="invite-card invite-unavailable" role="note">
        <p>{"The invitation details couldn't be loaded."}</p>
        <Button
          variant="ghost"
          size="small"
          aria-disabled={query.isFetching}
          onClick={() => {
            if (!query.isFetching) void query.refetch();
          }}
        >
          Retry
        </Button>
      </div>
    );
  return (
    <div className="invite-card invite-loading" aria-busy="true">
      Loading invitation…
    </div>
  );
}
