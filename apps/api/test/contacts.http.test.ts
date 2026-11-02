import { createReadinessService } from "@opensuite/core";
import { contactVcardCodec } from "@opensuite/core/adapters/contacts";
import { createContactsService } from "@opensuite/core/services/contacts";
import { err } from "neverthrow";
import { expect, it } from "vitest";
import { buildServer } from "../src/server.ts";

const now = () => performance.now();
it("enforces authentication, origin and account ownership over HTTP", async () => {
  const contacts = createContactsService({
    codec: contactVcardCodec,
    origin: "http://127.0.0.1:1",
    store: { getForOwner: () => Promise.resolve(err({ kind: "not_found" })) },
  });
  const app = await buildServer({
    config: { logLevel: "silent" },
    monotonicMs: now,
    readiness: createReadinessService({
      probes: [],
      timeoutMs: 100,
      now: () => new Date(),
      monotonicMs: now,
    }),
    contacts,
    identity: {
      publicOrigin: "https://suite.example.test",
      handler: () => Promise.resolve(new Response()),
      actor: (headers) =>
        Promise.resolve(
          headers.get("cookie") === "session"
            ? { id: "alice", email: "alice@example.test", role: "user" }
            : null,
        ),
    },
  });
  try {
    const base = await app.listen({ port: 0, host: "127.0.0.1" });
    const call = (headers: Record<string, string>) =>
      fetch(`${base}/contacts/list`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({ accountId: "default" }),
      });
    expect((await call({ origin: "https://suite.example.test" })).status).toBe(
      401,
    );
    expect(
      (await call({ origin: "https://evil.example.test", cookie: "session" }))
        .status,
    ).toBe(403);
    expect(
      (await call({ origin: "https://suite.example.test", cookie: "session" }))
        .status,
    ).toBe(403);
  } finally {
    await app.close();
  }
});
