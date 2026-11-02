import type { Result } from "neverthrow";

export interface InvitationEvent {
  uid: string;
  recurrenceId: string | null;
  recurrenceIdTimeZone: string | null;
  sequence: number;
  organizer: { email: string; name: string | null };
  attendees: { email: string; name: string | null; partstat: string }[];
  title: string;
  description: string;
  location: string;
  start: string | null;
  end: string | null;
  timeZone: string | null;
  recurrence: string[];
  meetingUrl: string | null;
}
export interface ParsedInvitation {
  method: "REQUEST" | "CANCEL";
  events: InvitationEvent[];
  calendar: string;
  from: string[];
  recipients: string[];
  signingDomains: string[];
}

export type Participation = "ACCEPTED" | "TENTATIVE" | "DECLINED";

export type InvitationProtocolFailure = {
  kind: "validation" | "conflict" | "unavailable";
};

export interface InvitationProtocol {
  parseInvitation(
    raw: Uint8Array,
  ): Promise<Result<ParsedInvitation, InvitationProtocolFailure>>;
  createInvitationReply(
    calendar: string,
    recipient: string,
    participation: Participation,
    recurrenceId: string | null,
    now: Date,
  ): Result<string, InvitationProtocolFailure>;
  mergeInvitationCalendar(
    previous: string | null,
    incoming: ParsedInvitation,
    recipient: string,
    response?: { participation: Participation; recurrenceId: string | null },
    organizerPrevious?: string | null,
  ): Result<string, InvitationProtocolFailure>;
  calendarSignature(
    calendar: string,
  ): Result<string, InvitationProtocolFailure>;
  findInvitationObject(input: {
    origin: string;
    address: string;
    secret: string;
    uid: string;
  }): Promise<Result<string | null, InvitationProtocolFailure>>;
}
