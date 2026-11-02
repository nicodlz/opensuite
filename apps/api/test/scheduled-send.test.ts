import Fastify from "fastify";
import { expect, it } from "vitest";
import { register } from "../src/adapters/scheduled-send-job.ts";

it("waits for scheduled-send reconciliation before disconnecting the database", async () => {
  const app = Fastify();
  const events: string[] = [];
  const { promise: pending, resolve: release } = Promise.withResolvers<void>();
  app.addHook("onClose", () => {
    events.push("disconnect");
    return Promise.resolve();
  });
  register(app, {
    reconcileScheduled: async () => {
      events.push("started");
      await pending;
      events.push("finished");
    },
  });
  await app.ready();
  const closing = app.close();
  await new Promise<void>((resolve) => setImmediate(resolve));
  const beforeRelease = [...events];
  release();
  await closing;
  expect(beforeRelease).toEqual(["started"]);
  expect(events).toEqual(["started", "finished", "disconnect"]);
});
