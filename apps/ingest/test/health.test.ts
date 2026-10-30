import { createReadinessService } from "@opensuite/core";
import { expect, it } from "vitest";
import { downProbe, upProbe } from "../../../test-support/probes.ts";
import { createHealthServer } from "../src/health.ts";

it("reports liveness separately from dependency readiness and shutdown", async () => {
  const service = createReadinessService({
    probes: [upProbe("queue"), downProbe("buffer-storage", "private detail")],
    timeoutMs: 100,
    now: () => new Date(),
    monotonicMs: () => performance.now(),
  });
  let stopping = false;
  const server = createHealthServer(service, () => stopping);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (address === null || typeof address === "string")
      throw new Error("no port");
    const base = `http://127.0.0.1:${String(address.port)}`;
    expect((await fetch(`${base}/health`)).status).toBe(200);
    const response = await fetch(`${base}/ready`);
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("private detail");
    stopping = true;
    expect((await fetch(`${base}/health`)).status).toBe(503);
    expect((await fetch(`${base}/ready`)).status).toBe(503);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
