import { err, ok } from "neverthrow";
import { describe, expect, it } from "vitest";
import { runWorker } from "../src/worker.ts";
import type { Queue, QueueMessage } from "@opensuite/core";

const item: QueueMessage = { body: "body", receipt: "receipt", attempts: 1 };
const noop = () => Promise.resolve(ok(undefined));

describe("worker shutdown", () => {
  it("stops polling and waits for the in-flight handler", async () => {
    const stop = new AbortController();
    let polls = 0;
    let finish: (() => void) | undefined;
    let running = false;
    const queue: Queue = {
      receive: () => {
        polls++;
        return Promise.resolve(ok([item]));
      },
      delete: noop,
      defer: noop,
    };
    const pending = runWorker(
      queue,
      async () => {
        running = true;
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
        return ok(undefined);
      },
      stop.signal,
      () => {},
    );
    await Promise.resolve();
    expect(running).toBe(true);
    stop.abort();
    let stopped = false;
    void pending.then(() => {
      stopped = true;
      return undefined;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    if (finish === undefined) throw new Error("handler did not start");
    finish();
    await pending;
    expect(polls).toBe(1);
  });
  it("aborts a pending receive without starting another", async () => {
    const stop = new AbortController();
    let polls = 0;
    const queue: Queue = {
      receive: (signal) => {
        polls++;
        return new Promise((resolve) =>
          signal?.addEventListener(
            "abort",
            () => resolve(err({ message: "aborted" })),
            { once: true },
          ),
        );
      },
      delete: noop,
      defer: noop,
    };
    const pending = runWorker(
      queue,
      () => Promise.resolve(ok(undefined)),
      stop.signal,
      () => {
        throw new Error("shutdown is not a poll failure");
      },
    );
    stop.abort();
    await pending;
    expect(polls).toBe(1);
  });
});
