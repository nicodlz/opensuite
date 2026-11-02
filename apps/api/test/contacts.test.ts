import { createReadinessService } from "@opensuite/core";
import { contactVcardCodec } from "@opensuite/core/adapters/contacts";
import { createContactsService } from "@opensuite/core/services/contacts";
import { err } from "neverthrow";
import { expect, it } from "vitest";
import { buildServer } from "../src/server.ts";

const now = () => performance.now();
it("requires a session and same origin, validates inputs, and fails closed on missing account credentials", async () => {
  const service = createContactsService({
    codec: contactVcardCodec,
    origin: "https://mail.example.test",
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
    contacts: service,
    identity: {
      publicOrigin: "https://suite.example.test",
      handler: () => Promise.resolve(new Response()),
      actor: (h) =>
        Promise.resolve(
          h.get("cookie")
            ? { id: "user", email: "user@example.test", role: "user" }
            : null,
        ),
    },
  });
  try {
    const request = (headers: Record<string, string>, payload: object) =>
      app.inject({ method: "POST", url: "/contacts/list", headers, payload });
    expect(
      (
        await request(
          { origin: "https://suite.example.test" },
          { accountId: "default" },
        )
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await request(
          { origin: "https://evil.example.test", cookie: "ok" },
          { accountId: "default" },
        )
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await request(
          { origin: "https://suite.example.test", cookie: "ok" },
          { accountId: "other" },
        )
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await request(
          { origin: "https://suite.example.test", cookie: "ok" },
          { accountId: "default", limit: 101 },
        )
      ).statusCode,
    ).toBe(400);
  } finally {
    await app.close();
  }
});
