import type { ParsedInvitation } from "../../domain/invitations/types.ts";
import type { Actor } from "../accounts.ts";
import { fail, value as jmapValue } from "../jmap-access.ts";
import type { Connection, InvitationContext } from "./context.ts";
import {
  digest,
  participation,
  protocolValue,
  status,
  type InvitationAction,
} from "./state.ts";
import { writeReserved } from "./write.ts";
import { canConfirmUnverified, verifiedOrganizer } from "./verification.ts";

async function chooseRecipient(
  ctx: InvitationContext,
  actor: Actor,
  input: InvitationAction,
  mailConnection: Connection,
  invite: ParsedInvitation,
  priorRecipient?: string,
) {
  const identities = jmapValue(
    await mailConnection.client.identities(
      mailConnection.session,
      mailConnection.id,
    ),
  ).list;
  const candidates = [...new Set(invite.recipients)].filter(
    (address) =>
      identities.some((item) => item.email.toLowerCase() === address) &&
      (invite.method !== "REQUEST" ||
        invite.events.every((event) =>
          event.attendees.some((item) => item.email === address),
        )),
  );
  const authorized = (
    await Promise.all(
      candidates.map(async (address) => ({
        address,
        allowed:
          address === mailConnection.address.toLowerCase() ||
          Boolean(await ctx.dependencies.canSendAs?.(actor.id, address)),
      })),
    )
  )
    .filter((item) => item.allowed)
    .map((item) => item.address);
  const recipient =
    input.recipient?.toLowerCase() ??
    priorRecipient ??
    (authorized.includes(mailConnection.address.toLowerCase())
      ? mailConnection.address.toLowerCase()
      : authorized.length === 1
        ? authorized[0]
        : undefined);
  if (!recipient || !authorized.includes(recipient)) return fail("forbidden");
  return recipient;
}

function checkPrior(
  prior: Awaited<
    ReturnType<ReturnType<InvitationContext["intentions"]>["series"]>
  >,
  input: InvitationAction,
  organizer: string,
  recipient: string,
) {
  if (!prior?.calendar && input.action === "apply") fail("not_found");
  if (
    prior &&
    (prior.organizer !== organizer ||
      prior.recipient !== recipient ||
      prior.calendarId !== input.calendarId)
  )
    fail("conflict");
  if (prior?.pendingId) fail("conflict");
}

async function validateTarget(
  ctx: InvitationContext,
  actor: Actor,
  input: InvitationAction,
  calendarConnection: Connection,
  prior: Awaited<
    ReturnType<ReturnType<InvitationContext["intentions"]>["series"]>
  >,
  organizer: string,
  uid: string,
  recipient: string,
) {
  const calendars = jmapValue(
    await calendarConnection.client.calendars(
      calendarConnection.session,
      calendarConnection.id,
    ),
  ).list;
  const selected =
    calendars.find((item) => item.id === input.calendarId) ?? fail("not_found");
  if (selected.myRights?.mayWriteAll !== true) fail("forbidden");
  checkPrior(prior, input, organizer, recipient);
  if (prior?.eventId) {
    const { event } = await ctx.getEvent(calendarConnection, prior.eventId);
    if (event.uid !== uid || !event.calendarIds[input.calendarId])
      return fail("conflict");
    const current = await ctx.rawCalendar(actor, input.accountId, uid);
    if (!current || !prior.calendar) return fail("conflict");
    return current;
  } else if ((await ctx.eventsWithUid(calendarConnection, uid)).found.length)
    fail("conflict");
  return null;
}

async function mergeAndValidate(
  ctx: InvitationContext,
  calendarConnection: Connection,
  invite: ParsedInvitation,
  previous: string | null,
  recipient: string,
  choice: ReturnType<typeof participation>,
  recurrenceId: string | null,
  uid: string,
  organizerPrevious?: string | null,
) {
  const merged = protocolValue(
    ctx.dependencies.protocol.mergeInvitationCalendar(
      previous,
      invite,
      recipient,
      choice ? { participation: choice, recurrenceId } : undefined,
      organizerPrevious,
    ),
  );
  const event = await ctx.parsedCalendar(calendarConnection, merged);
  if (event["uid"] !== uid) return fail("conflict");
  return merged;
}

function responseChoice(invite: ParsedInvitation, input: InvitationAction) {
  const choice = participation(input.action);
  if (
    (invite.method === "CANCEL" && choice) ||
    (invite.method === "REQUEST" && !choice && input.action !== "apply")
  )
    return fail("validation");
  return choice;
}

async function prepareAction(
  ctx: InvitationContext,
  actor: Actor,
  input: InvitationAction,
) {
  const mailConnection = await ctx.mail(actor, input.accountId);
  const calendarConnection = await ctx.calendar(actor, input.accountId);
  const invite = await ctx.read(mailConnection, input.messageId);
  const first = invite.events[0] ?? fail("validation");
  if (invite.from.length !== 1 || invite.from[0] !== first.organizer.email)
    return fail("forbidden");
  const identity = {
    userId: actor.id,
    accountId: calendarConnection.id,
    uid: first.uid,
  };
  const prior = await ctx.intentions().series(identity);
  const recipient = await chooseRecipient(
    ctx,
    actor,
    input,
    mailConnection,
    invite,
    prior?.recipient,
  );
  return {
    mailConnection,
    calendarConnection,
    invite,
    first,
    identity,
    prior,
    recipient,
  };
}

async function calendarsForAction(
  ctx: InvitationContext,
  input: InvitationAction,
  details: Awaited<ReturnType<typeof prepareAction>>,
  choice: ReturnType<typeof participation>,
  current: string | null,
) {
  const { calendarConnection, invite, prior, recipient, first } = details;
  const organizerCalendar = await mergeAndValidate(
    ctx,
    calendarConnection,
    invite,
    prior?.calendar ?? null,
    recipient,
    choice,
    input.recurrenceId,
    first.uid,
  );
  const calendar = current
    ? await mergeAndValidate(
        ctx,
        calendarConnection,
        invite,
        current,
        recipient,
        choice,
        input.recurrenceId,
        first.uid,
        prior?.calendar,
      )
    : organizerCalendar;
  return {
    calendar,
    organizerCalendar,
    baseSnapshot: current ? digest(current) : null,
  };
}

export async function act(
  ctx: InvitationContext,
  actor: Actor,
  input: InvitationAction,
  confirmed = false,
) {
  const store = ctx.intentions();
  const prepared = await prepareAction(ctx, actor, input);
  const {
    mailConnection,
    calendarConnection,
    invite,
    first,
    identity,
    prior,
    recipient,
  } = prepared;
  const choice = responseChoice(invite, input);
  const fingerprint = digest([
    actor.id,
    calendarConnection.id,
    input,
    confirmed,
  ]);
  const oldOperation = await store.operation(actor.id, input.requestId);
  if (oldOperation)
    return oldOperation.fingerprint === fingerprint
      ? status(oldOperation)
      : fail("conflict");
  const verified = await verifiedOrganizer(
    ctx,
    mailConnection,
    input.messageId,
    invite,
    prior?.organizer,
  );
  if (!verified && !canConfirmUnverified(confirmed, invite, choice, prior))
    return fail("forbidden");
  const current = await validateTarget(
    ctx,
    actor,
    input,
    calendarConnection,
    prior,
    first.organizer.email,
    first.uid,
    recipient,
  );
  const calendars = await calendarsForAction(
    ctx,
    input,
    prepared,
    choice,
    current,
  );
  const operation = await store.reserve(
    {
      ...identity,
      organizer: first.organizer.email,
      recipient,
      calendarId: input.calendarId,
    },
    {
      id: input.requestId,
      fingerprint,
      ...calendars,
      participation: choice ?? null,
      recurrenceId: input.recurrenceId,
    },
    prior?.revision ?? null,
  );
  if (!operation) return fail("conflict");
  await writeReserved(ctx, actor, input.accountId, operation);
  const result = await store.operation(actor.id, operation.id);
  return result ? status(result) : fail("unavailable");
}
