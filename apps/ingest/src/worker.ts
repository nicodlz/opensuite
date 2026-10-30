import { setTimeout as delay } from "node:timers/promises";
import type { Failure, Queue, QueueMessage } from "@opensuite/core";
import type { Result } from "neverthrow";

export async function runWorker(
  queue: Queue,
  handle: (item: QueueMessage) => Promise<Result<void, Failure>>,
  signal: AbortSignal,
  onPollError: () => void,
): Promise<void> {
  const stopping = () => signal.aborted;
  const pollOnce = async (): Promise<boolean> => {
    const received = await queue.receive(signal);
    if (received.isErr()) {
      if (stopping()) return false;
      onPollError();
      try {
        await delay(5000, undefined, { signal });
      } catch {
        if (!stopping()) throw new Error("Queue backoff interrupted");
      }
      return false;
    }
    // A receive may complete concurrently with shutdown; finish anything it returned.
    await Promise.all(received.value.map((item) => handle(item)));
    return true;
  };
  async function* polls(): AsyncGenerator<boolean> {
    while (!stopping()) yield pollOnce();
  }
  for await (const result of polls()) {
    if (!result) continue;
  }
}
