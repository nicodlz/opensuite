import { SessionResponseSchema } from "@opensuite/contracts";
import { ResultAsync } from "neverthrow";
import { z } from "zod";
import type { SessionVerifier } from "../domain/session.ts";

const InternalSessionSchema = z.object({
  userId: z.string().min(1).max(200).nullable(),
});

const check = (url: URL, headers: Record<string, string>): Promise<Response> =>
  fetch(url, {
    headers,
    signal: AbortSignal.timeout(5000),
    redirect: "error",
  });

// Public route, kept for an API without the service token.
const publicSession = async (baseUrl: string, cookie: string) => {
  const response = await check(
    new URL("/auth/get-session?disableCookieCache=true", baseUrl),
    { cookie },
  );
  if (!response.ok) throw new Error("session endpoint failed");
  const data = SessionResponseSchema.parse(await response.json());
  if (data === null) return null;
  if (
    data.user.id !== data.session.userId ||
    Date.parse(data.session.expiresAt) <= Date.now()
  )
    return null;
  return data.user.id;
};

/**
 * With the service token, sessions are checked on the API's internal route,
 * outside the per-network sign-in limits that every Drive user would share.
 * Every request is checked again, so a sign-out or revocation applies to the
 * next one.
 */
export const httpSessionVerifier = (
  baseUrl: string,
  token?: string,
): SessionVerifier => ({
  verify(cookie) {
    return ResultAsync.fromPromise(
      (async () => {
        if (cookie === undefined || cookie.length === 0) return null;
        if (token === undefined) return publicSession(baseUrl, cookie);
        const response = await check(new URL("/internal/session", baseUrl), {
          authorization: `Bearer ${token}`,
          cookie,
        });
        if (!response.ok) throw new Error("session endpoint failed");
        return InternalSessionSchema.parse(await response.json()).userId;
      })(),
      () => "unavailable" as const,
    );
  },
});
