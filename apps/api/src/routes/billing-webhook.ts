import type { FastifyInstance } from "fastify";
import type { ServerDependencies } from "./server-dependencies.ts";

export async function registerBillingWebhook(
  app: FastifyInstance,
  dependencies: ServerDependencies,
) {
  if (
    dependencies.billing !== undefined &&
    dependencies.webhook !== undefined
  ) {
    const stripe = dependencies.billing.client;
    const webhook = dependencies.webhook;
    await app.register((scope, _options, done) => {
      scope.removeContentTypeParser("application/json");
      scope.addContentTypeParser(
        "application/json",
        { parseAs: "buffer", bodyLimit: 65_536 },
        (_request, body, parseDone) => parseDone(null, body),
      );
      scope.post(
        "/billing/webhook",
        { bodyLimit: 65_536 },
        async (request, reply) => {
          const signature = request.headers["stripe-signature"];
          if (typeof signature !== "string" || !Buffer.isBuffer(request.body))
            return reply.code(400).send({ code: "BAD_SIGNATURE" });
          let event;
          try {
            event = stripe.webhooks.constructEvent(
              request.body,
              signature,
              webhook.secret,
            );
          } catch {
            return reply.code(400).send({ code: "BAD_SIGNATURE" });
          }
          try {
            await webhook.processor.process(event);
            return { received: true };
          } catch (error) {
            const code =
              typeof error === "object" &&
              error !== null &&
              "code" in error &&
              typeof error.code === "string" &&
              /^[a-z0-9_]{1,80}$/.test(error.code)
                ? error.code
                : null;
            request.log.error(
              { eventId: event.id, eventType: event.type, stripeCode: code },
              "billing webhook failed",
            );
            return reply.code(500).send({ code: "PROCESSING_FAILED" });
          }
        },
      );
      done();
    });
  }
}
