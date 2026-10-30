import { randomUUID } from "node:crypto";
import { contract } from "@opensuite/contracts";
import { implement, ORPCError } from "@orpc/server";
import { requireSession } from "./session.ts";
import type { ApiContext } from "./context.ts";

const push = implement(contract.push).$context<ApiContext>();
const service = (context: ApiContext) => {
  if (!context.push)
    throw new ORPCError("SERVICE_UNAVAILABLE", { status: 503 });
  return context.push;
};
export const pushRouter = push.router({
  publicKey: push.publicKey
    .use(requireSession)
    .handler(({ context }) => ({ publicKey: service(context).publicKey })),
  subscribe: push.subscribe
    .use(requireSession)
    .handler(async ({ context, input }) => {
      if (!context.pushSubscribeLimit(context.actor.id))
        throw new ORPCError("TOO_MANY_REQUESTS");
      if (
        !(await service(context).store.subscribe(
          context.actor.id,
          input,
          context.actor.sessionId,
        ))
      )
        throw new ORPCError("CONFLICT");
      return { ok: true as const };
    }),
  status: push.status
    .use(requireSession)
    .handler(async ({ context, input }) => {
      const store = service(context).store;
      const subscribed = await store.status(
        context.actor.id,
        input.product,
        input.endpoint,
      );
      if (
        subscribed &&
        input.product === "calendar" &&
        input.timeZone !== undefined
      )
        await store.setCalendarTimeZone(context.actor.id, input.timeZone);
      return { subscribed };
    }),
  clearSession: push.clearSession
    .use(requireSession)
    .handler(async ({ context }) => {
      if (context.pushCleanup && context.actor.sessionId)
        await context.pushCleanup.unsubscribeSession(
          context.actor.id,
          context.actor.sessionId,
        );
      return { ok: true as const };
    }),
  unsubscribe: push.unsubscribe
    .use(requireSession)
    .handler(async ({ context, input }) => {
      if (!context.pushCleanup)
        throw new ORPCError("SERVICE_UNAVAILABLE", { status: 503 });
      await context.pushCleanup.unsubscribe(
        context.actor.id,
        input.product,
        input.endpoint,
      );
      return { ok: true as const };
    }),
  test: push.test.use(requireSession).handler(async ({ context, input }) => {
    if (!context.pushTestLimit(context.actor.id))
      throw new ORPCError("TOO_MANY_REQUESTS");
    await service(context).dispatcher.notify(context.actor.id, input.product, {
      title: "Esuno test notification",
      body: "Notifications are enabled.",
      url: `/${input.product}`,
      tag: `test-${randomUUID()}`,
    });
    return { ok: true as const };
  }),
  privacy: push.privacy.use(requireSession).handler(async ({ context }) => ({
    showDetails: await service(context).store.privacy(context.actor.id),
  })),
  setPrivacy: push.setPrivacy
    .use(requireSession)
    .handler(async ({ context, input }) => {
      await service(context).store.setPrivacy(
        context.actor.id,
        input.showDetails,
      );
      return { ok: true as const };
    }),
});
