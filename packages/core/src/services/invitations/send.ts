import { randomUUID } from "node:crypto";
import type { Participation } from "../../domain/invitations/types.ts";
import type { Actor } from "../accounts.ts";
import { fail, value as jmapValue } from "../jmap-access.ts";
import type { Connection, InvitationContext, Operation } from "./context.ts";
import { protocolValue } from "./state.ts";

async function prepareDraft(
  ctx: InvitationContext,
  actor: Actor,
  c: Connection,
  operation: Operation,
  choice: Participation,
  identityId: string,
  draftsId: string,
): Promise<boolean> {
  const store = ctx.intentions();
  // A new generation invalidates any earlier in-flight draft creation before it can submit.
  const generation = `draftCreating:${randomUUID()}`;
  if (
    !(await store.transition(
      actor.id,
      operation.id,
      operation.phase,
      generation,
    ))
  )
    return false;
  const reply = protocolValue(
    ctx.dependencies.protocol.createInvitationReply(
      operation.calendar,
      operation.series.recipient,
      choice,
      operation.recurrenceId,
      new Date(ctx.access.now()),
    ),
  );
  const uploaded = jmapValue(
    await c.client.upload(
      c.session,
      c.id,
      Buffer.from(reply),
      "text/calendar; method=REPLY; charset=utf-8",
    ),
  );
  const draft = jmapValue(
    await c.client.createEmail(c.session, c.id, {
      mailboxIds: { [draftsId]: true },
      keywords: { $draft: true, $seen: true },
      from: [{ email: operation.series.recipient }],
      to: [{ email: operation.series.organizer }],
      subject: `Invitation response: ${choice.toLowerCase()}`,
      bodyValues: {
        text: { value: `Invitation response: ${choice.toLowerCase()}` },
      },
      textBody: [{ partId: "text", type: "text/plain" }],
      attachments: [
        {
          blobId: uploaded.blobId,
          type: "text/calendar; method=REPLY; charset=utf-8",
          name: "reply.ics",
        },
      ],
    }),
  );
  if (
    !(await store.transition(actor.id, operation.id, generation, "prepared", {
      draftId: draft.id,
      identityId: identityId,
    }))
  )
    return false;
  return true;
}

async function findSendTarget(
  ctx: InvitationContext,
  actor: Actor,
  accountId: string,
  operation: Operation,
) {
  const c = await ctx.mail(actor, accountId);
  const aliasId =
    operation.series.recipient === c.address.toLowerCase()
      ? null
      : await ctx.dependencies.canSendAs?.(
          actor.id,
          operation.series.recipient,
        );
  if (operation.series.recipient !== c.address.toLowerCase() && !aliasId)
    return fail("forbidden");
  const identities = jmapValue(await c.client.identities(c.session, c.id)).list;
  const recipient = operation.series.recipient;
  const identity =
    identities.find((item) => item.email.toLowerCase() === recipient) ??
    fail("unavailable");
  const boxes = jmapValue(await c.client.mailboxes(c.session, c.id)).list;
  const drafts =
    boxes.find((box) => box.role === "drafts") ?? fail("unavailable");
  const sent = boxes.find((box) => box.role === "sent") ?? fail("unavailable");
  return { c, aliasId, identity, drafts, sent };
}

async function submitPrepared(
  ctx: InvitationContext,
  actor: Actor,
  c: Connection,
  operation: Operation,
  aliasId: string | null | undefined,
  identityId: string,
  sentId: string,
) {
  const store = ctx.intentions();
  if (operation.phase !== "prepared" || !operation.draftId) return;
  if (operation.identityId !== identityId) fail("conflict");
  if (aliasId) {
    if (
      (await ctx.dependencies.canSendAs?.(
        actor.id,
        operation.series.recipient,
      )) !== aliasId
    )
      fail("forbidden");
    if (!(await ctx.dependencies.beforeAliasSend?.(actor.id, aliasId)))
      fail("rate_limited");
  }
  if (!(await store.transition(actor.id, operation.id, "prepared", "sending")))
    return;
  const submitted = await c.client.submit(
    c.session,
    c.id,
    operation.draftId,
    identityId,
    {
      mailFrom: { email: operation.series.recipient },
      rcptTo: [{ email: operation.series.organizer }],
    },
    sentId,
  );
  // A failed follow-up Email/set may have already sent the message. Only the
  // submission's own notCreated response proves that sending was rejected.
  if (
    submitted.isErr() &&
    submitted.error.kind === "set" &&
    submitted.error.method === "EmailSubmission/set" &&
    submitted.error.id === "item"
  )
    await store.transition(actor.id, operation.id, "sending", "rejected", {
      release: true,
    });
  jmapValue(submitted);
  await store.transition(actor.id, operation.id, "sending", "sent", {
    release: true,
  });
}

export async function send(
  ctx: InvitationContext,
  actor: Actor,
  accountId: string,
  operationId: string,
): Promise<void> {
  const store = ctx.intentions();
  let operation = await store.operation(actor.id, operationId);
  if (!operation) return;
  if (!operation.participation) {
    if (operation.phase === "calendarApplied")
      await store.transition(
        actor.id,
        operation.id,
        "calendarApplied",
        "applied",
        { release: true },
      );
    return;
  }
  const rawChoice = operation.participation;
  const choice: Participation =
    rawChoice === "ACCEPTED" ||
    rawChoice === "TENTATIVE" ||
    rawChoice === "DECLINED"
      ? rawChoice
      : fail("conflict");
  const { c, aliasId, identity, drafts, sent } = await findSendTarget(
    ctx,
    actor,
    accountId,
    operation,
  );
  if (
    operation.phase === "calendarApplied" ||
    operation.phase.startsWith("draftCreating:")
  ) {
    if (
      !(await prepareDraft(
        ctx,
        actor,
        c,
        operation,
        choice,
        identity.id,
        drafts.id,
      ))
    )
      return;
    operation = await store.operation(actor.id, operationId);
    if (!operation) return;
  }
  await submitPrepared(ctx, actor, c, operation, aliasId, identity.id, sent.id);
}
