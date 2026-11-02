import { randomUUID } from "node:crypto";
import type { Actor } from "../accounts.ts";
import { fail, value } from "../jmap-access.ts";
import type {
  OrganizerContext,
  OrganizerOperation,
} from "./organizer-context.ts";

type Delivery = OrganizerOperation["deliveries"][number];
const senderForDelivery = (
  ctx: OrganizerContext,
  actor: Actor,
  accountId: string,
  op: OrganizerOperation,
  item: Delivery,
) =>
  item.identityId
    ? ctx.senderIfAuthorized(
        actor,
        accountId,
        op.series.organizer,
        item.identityId,
      )
    : null;
async function draft(
  ctx: OrganizerContext,
  actor: Actor,
  accountId: string,
  op: OrganizerOperation,
  item: Delivery,
) {
  const sender = await senderForDelivery(ctx, actor, accountId, op, item);
  if (!sender) {
    await ctx.organized.delivery(
      actor.id,
      op.id,
      item.id,
      item.phase,
      "rejected:sender",
    );
    return;
  }
  const { mail, identity } = sender;
  const boxes = value(await mail.client.mailboxes(mail.session, mail.id)).list;
  const drafts =
    boxes.find((box) => box.role === "drafts") ?? fail("unavailable");
  const generation = `draftCreating:${randomUUID()}`;
  if (
    !(await ctx.organized.delivery(
      actor.id,
      op.id,
      item.id,
      item.phase,
      generation,
    ))
  )
    return;
  const type = `text/calendar; method=${item.method}; charset=utf-8`;
  const uploaded = value(
    await mail.client.upload(
      mail.session,
      mail.id,
      Buffer.from(item.calendar),
      type,
    ),
  );
  const email = value(
    await mail.client.createEmail(mail.session, mail.id, {
      mailboxIds: { [drafts.id]: true },
      keywords: { $draft: true, $seen: true },
      from: [{ email: op.series.organizer }],
      to: [{ email: item.recipient }],
      subject:
        item.method === "CANCEL"
          ? "Calendar cancellation"
          : "Calendar invitation",
      bodyValues: {
        text: {
          value:
            item.method === "CANCEL"
              ? "Calendar cancellation"
              : "Calendar invitation",
        },
      },
      textBody: [{ partId: "text", type: "text/plain" }],
      attachments: [{ blobId: uploaded.blobId, type, name: "invite.ics" }],
    }),
  );
  await ctx.organized.delivery(
    actor.id,
    op.id,
    item.id,
    generation,
    "prepared",
    { draftId: email.id, identityId: identity.id },
  );
}
function submissionPhase(result: Parameters<typeof value<{ id: string }>>[0]) {
  if (result.isOk()) return "sent" as const;
  const error = result.error;
  if (error.kind === "network" && error.beforeRequest === true)
    return "prepared" as const;
  // A method-level failure is atomic except for serverPartialFail. A JMAP
  // request rejection and selected HTTP rejection statuses also prove the
  // submission was not accepted; other responses remain uncertain.
  if (
    (error.kind === "method" &&
      error.method === "EmailSubmission/set" &&
      error.type !== "serverPartialFail") ||
    (error.kind === "request" &&
      error.type.startsWith("urn:ietf:params:jmap:error:")) ||
    ((error.kind === "http" || error.kind === "request") &&
      [400, 401, 403, 404, 405, 413, 415, 422, 429].includes(error.status))
  )
    return "rejected" as const;
  if (
    error.kind === "set" &&
    error.method === "EmailSubmission/set" &&
    error.id === "item"
  )
    return "rejected" as const;
  return null;
}
async function confirmSenderBeforeSubmit(
  ctx: OrganizerContext,
  actor: Actor,
  accountId: string,
  op: OrganizerOperation,
  item: Delivery,
  generation: string,
  original: NonNullable<
    Awaited<ReturnType<OrganizerContext["senderIfAuthorized"]>>
  >,
) {
  try {
    const sender = await ctx.senderIfAuthorized(
      actor,
      accountId,
      op.series.organizer,
      original.identity.id,
    );
    if (
      sender &&
      sender.identity.id === original.identity.id &&
      sender.alias === original.alias
    )
      return true;
    await ctx.organized.delivery(
      actor.id,
      op.id,
      item.id,
      generation,
      "rejected:sender",
    );
    return false;
  } catch (error) {
    // This worker has not called submit, so its claim is safe to retry.
    await ctx.organized.delivery(
      actor.id,
      op.id,
      item.id,
      generation,
      "prepared",
    );
    throw error;
  }
}
async function submit(
  ctx: OrganizerContext,
  actor: Actor,
  accountId: string,
  op: OrganizerOperation,
  item: Delivery,
) {
  const sender = await senderForDelivery(ctx, actor, accountId, op, item);
  if (
    !sender ||
    !item.draftId ||
    !item.identityId ||
    sender.identity.id !== item.identityId
  ) {
    await ctx.organized.delivery(
      actor.id,
      op.id,
      item.id,
      "prepared",
      "rejected:sender",
    );
    return;
  }
  const { mail, identity, alias } = sender;
  const draftId = item.draftId;
  if (alias && !(await ctx.dependencies.beforeAliasSend?.(actor.id, alias)))
    fail("rate_limited");
  const sent =
    value(await mail.client.mailboxes(mail.session, mail.id)).list.find(
      (box) => box.role === "sent",
    ) ?? fail("unavailable");
  const generation = `sending:${randomUUID()}`;
  if (
    !(await ctx.organized.delivery(
      actor.id,
      op.id,
      item.id,
      "prepared",
      generation,
    ))
  )
    return;
  if (
    !(await confirmSenderBeforeSubmit(
      ctx,
      actor,
      accountId,
      op,
      item,
      generation,
      sender,
    ))
  )
    return;
  const submitted = await mail.client.submit(
    mail.session,
    mail.id,
    draftId,
    identity.id,
    {
      mailFrom: { email: op.series.organizer },
      rcptTo: [{ email: item.recipient }],
    },
    sent.id,
  );
  const phase = submissionPhase(submitted);
  if (phase)
    await ctx.organized.delivery(actor.id, op.id, item.id, generation, phase);
}
async function reconcileSending(
  ctx: OrganizerContext,
  actor: Actor,
  accountId: string,
  op: OrganizerOperation,
  item: Delivery,
) {
  if (!item.draftId || !item.identityId) return;
  // Reading an existing submission remains safe after an alias is revoked.
  const mail = await ctx.mail(actor, accountId);
  const found = value(
    await mail.client.submissionQuery(mail.session, mail.id, item.draftId),
  );
  if (!found.ids.length) return;
  const submissions = value(
    await mail.client.submissions(mail.session, mail.id, found.ids),
  );
  const match =
    submissions.notFound.length === 0 &&
    submissions.list.some(
      (submission) =>
        submission.emailId === item.draftId &&
        submission.identityId === item.identityId &&
        submission.undoStatus !== "canceled" &&
        submission.envelope?.mailFrom.email.toLowerCase() ===
          op.series.organizer &&
        submission.envelope.rcptTo.length === 1 &&
        submission.envelope.rcptTo[0]?.email.toLowerCase() === item.recipient,
    );
  if (match)
    await ctx.organized.delivery(actor.id, op.id, item.id, item.phase, "sent");
}
export async function sendOrganizerDeliveries(
  ctx: OrganizerContext,
  actor: Actor,
  accountId: string,
  op: OrganizerOperation,
) {
  if (op.phase !== "calendarApplied") return;
  const sendAt = async (index: number): Promise<void> => {
    const item = op.deliveries[index];
    if (!item) return;
    if (item.phase === "reserved" || item.phase.startsWith("draftCreating:"))
      await draft(ctx, actor, accountId, op, item);
    const refreshed =
      (await ctx.organized.operation(actor.id, op.id)) ?? fail("conflict");
    const current =
      refreshed.deliveries.find((delivery) => delivery.id === item.id) ??
      fail("conflict");
    if (current.phase === "prepared")
      await submit(ctx, actor, accountId, refreshed, current);
    else if (
      current.phase === "sending" ||
      current.phase.startsWith("sending:")
    )
      await reconcileSending(ctx, actor, accountId, refreshed, current);
    await sendAt(index + 1);
  };
  await sendAt(0);
  await ctx.organized.finish(actor.id, op.id);
}
