import { SessionResponseSchema } from "@opensuite/contracts";
import { ResultAsync } from "neverthrow";
import type { SessionVerifier } from "../domain/session.ts";

export const httpSessionVerifier = (baseUrl: string): SessionVerifier => ({
  verify(cookie) {
    return ResultAsync.fromPromise(
      (async () => {
        if (cookie === undefined || cookie.length === 0) return null;
        const url = new URL(
          "/api/auth/get-session?disableCookieCache=true",
          baseUrl,
        );
        const response = await fetch(url, {
          headers: { cookie },
          signal: AbortSignal.timeout(5000),
          redirect: "error",
        });
        if (!response.ok) throw new Error("session endpoint failed");
        const data = SessionResponseSchema.parse(await response.json());
        if (data === null) return null;
        if (
          data.user.id !== data.session.userId ||
          Date.parse(data.session.expiresAt) <= Date.now()
        )
          return null;
        return data.user.id;
      })(),
      () => "unavailable",
    );
  },
});
