import { createReadinessService } from "@opensuite/core";
import { expect, it } from "vitest";
import { buildServer } from "../src/server.ts";

const token = "s".repeat(32);
const build = (actor: (headers: Headers) => Promise<{ id: string } | null>) =>
  buildServer({
    config: { logLevel: "silent" },
    readiness: createReadinessService({
      probes: [],
      timeoutMs: 100,
      now: () => new Date(),
      monotonicMs: () => 0,
    }),
    monotonicMs: () => 0,
    identity: {
      publicOrigin: "https://mail.example.test",
      // Stands in for Better Auth's own limiter, already exhausted.
      handler: () => Promise.resolve(new Response(null, { status: 429 })),
      actor: (headers) =>
        actor(headers).then((user) =>
          user === null
            ? null
            : { ...user, email: `${user.id}@example.test`, role: "user" },
        ),
    },
    internalToken: token,
  });

it("answers Drive session checks with the service token, outside the auth limits", async () => {
  const seen: (string | null)[] = [];
  const app = await build((headers) => {
    seen.push(headers.get("cookie"));
    const match = /session_token=([a-z]+)/.exec(headers.get("cookie") ?? "");
    return Promise.resolve(match?.[1] ? { id: match[1] } : null);
  });
  const check = (cookie?: string, authorization = `Bearer ${token}`) =>
    app.inject({
      url: "/internal/session",
      headers: { authorization, ...(cookie === undefined ? {} : { cookie }) },
    });
  try {
    expect(
      (await check("__Host-opensuite.session_token=ann", "")).statusCode,
    ).toBe(401);
    expect(
      (
        await check(
          "__Host-opensuite.session_token=ann",
          `Bearer ${"t".repeat(32)}`,
        )
      ).statusCode,
    ).toBe(401);
    const answers = await Promise.all(
      Array.from({ length: 250 }, (_, index) =>
        check(`__Host-opensuite.session_token=${index % 2 ? "ann" : "bob"}`),
      ),
    );
    expect(answers.map((answer) => answer.statusCode)).toEqual(
      answers.map(() => 200),
    );
    expect(answers.map((answer): unknown => answer.json())).toEqual(
      answers.map((_, index) => ({ userId: index % 2 ? "ann" : "bob" })),
    );
    expect(answers[0]?.headers["cache-control"]).toBe("no-store");
    seen.length = 0;
    expect((await check()).json()).toEqual({ userId: null });
    expect(
      (
        await check(
          "__Host-opensuite.session_token=ann; __Host-opensuite.two_factor=x",
        )
      ).json(),
    ).toEqual({ userId: null });
    expect(seen).toEqual([]);
    expect(
      (
        await check(
          "__Host-opensuite.session_token=ann; __Host-opensuite.session_token=bob",
        )
      ).statusCode,
    ).toBe(400);
    expect((await check("other=1")).json()).toEqual({ userId: null });
    expect(seen).toEqual(["other=1"]);
  } finally {
    await app.close();
  }
});

it("reports an unavailable account lookup instead of a signed-out user", async () => {
  const app = await build(() => Promise.reject(new Error("database down")));
  try {
    const answer = await app.inject({
      url: "/internal/session",
      headers: {
        authorization: `Bearer ${token}`,
        cookie: "__Host-opensuite.session_token=ann",
      },
    });
    expect(answer.statusCode).toBe(503);
  } finally {
    await app.close();
  }
});
