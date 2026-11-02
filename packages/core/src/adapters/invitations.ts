import {
  rebaseOrganized,
  organizerFields,
  restoreOrganizerParticipants,
} from "./invitations/organizer-rebase.ts";
import { err, ok, type Result } from "neverthrow";
import type {
  InvitationProtocol,
  InvitationProtocolFailure,
} from "../domain/invitations/types.ts";
import { parseInvitation, parseInvitationReply } from "./invitations/parse.ts";
import type { OrganizerProtocol } from "../domain/invitations/organizer.ts";
import {
  prepareOrganizedCalendar,
  organizedAttendees,
  hasOrganizedOccurrence,
} from "./invitations/organize.ts";
import { createInvitationReply } from "./invitations/reply.ts";
import { mergeInvitationCalendar } from "./invitations/merge.ts";
import { calendarSignature } from "./invitations/signatures.ts";
import {
  DuplicateInvitationUid,
  findInvitationObject,
} from "./invitations/dav.ts";

export {
  parseInvitation,
  parseInvitationReply,
  createInvitationReply,
  calendarSignature,
  mergeInvitationCalendar,
  findInvitationObject,
};
function capture<T>(
  work: () => T,
  kind: InvitationProtocolFailure["kind"],
): Result<T, InvitationProtocolFailure> {
  try {
    return ok(work());
  } catch (error) {
    return err({
      kind: error instanceof DuplicateInvitationUid ? "conflict" : kind,
    });
  }
}
async function captureAsync<T>(
  work: () => Promise<T>,
  kind: InvitationProtocolFailure["kind"],
): Promise<Result<T, InvitationProtocolFailure>> {
  try {
    return ok(await work());
  } catch (error) {
    return err({
      kind: error instanceof DuplicateInvitationUid ? "conflict" : kind,
    });
  }
}
export const invitationProtocol: InvitationProtocol = {
  parseInvitation: (raw) =>
    captureAsync(() => parseInvitation(raw), "validation"),
  createInvitationReply: (...args) =>
    capture(() => createInvitationReply(...args), "conflict"),
  mergeInvitationCalendar: (...args) =>
    capture(() => mergeInvitationCalendar(...args), "conflict"),
  calendarSignature: (calendar) =>
    capture(() => calendarSignature(calendar), "unavailable"),
  findInvitationObject: (input) =>
    captureAsync(() => findInvitationObject(input), "unavailable"),
};

export const organizerProtocol: OrganizerProtocol = {
  restoreParticipants: (previous, current) =>
    capture(() => restoreOrganizerParticipants(previous, current), "conflict"),
  fields: (calendar) => capture(() => organizerFields(calendar), "conflict"),
  rebase: (...args) => capture(() => rebaseOrganized(...args), "conflict"),
  parseReply: (raw) =>
    captureAsync(() => parseInvitationReply(raw), "validation"),
  prepare: (input) =>
    capture(() => prepareOrganizedCalendar(input), "validation"),
  attendees: (calendar) =>
    capture(() => organizedAttendees(calendar), "conflict"),
  hasOccurrence: (calendar, occurrence) =>
    capture(() => hasOrganizedOccurrence(calendar, occurrence), "conflict"),
};
