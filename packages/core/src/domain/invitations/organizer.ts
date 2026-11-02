import type { EventContent } from "@opensuite/contracts";
import type { Result } from "neverthrow";
import type {
  InvitationProtocolFailure,
  ParsedInvitationReply,
} from "./types.ts";

type ProtocolResult<T> = Result<T, InvitationProtocolFailure>;
export type OrganizerEdit = {
  previous: string | null;
  uid: string;
  organizer: string;
  attendees: string[];
  sequence: number;
  event: EventContent;
  changes: {
    title: boolean;
    description: boolean;
    location: boolean;
    time: boolean;
    recurrence: boolean;
  };
  cancelled: boolean;
  now: Date;
};
export type OrganizerProtocol = {
  parseReply(raw: Uint8Array): Promise<ProtocolResult<ParsedInvitationReply>>;
  prepare(input: OrganizerEdit): ProtocolResult<{
    calendar: string;
    deliveries: {
      recipient: string;
      method: "REQUEST" | "CANCEL";
      calendar: string;
    }[];
  }>;
  attendees(
    calendar: string,
  ): ProtocolResult<{ email: string; partstat: string }[]>;
  restoreParticipants(
    previous: string,
    current: string,
  ): ProtocolResult<string>;
  fields(
    calendar: string,
  ): ProtocolResult<{ title: string; description: string; location: string }>;
  rebase(
    previous: string,
    current: string,
    uid: string,
    organizer: string,
    allowScheduleChanges: boolean,
  ): ProtocolResult<number>;
  hasOccurrence(calendar: string, occurrence: string): ProtocolResult<boolean>;
};
