import { createFixedWindow } from "./fixed-window.ts";
import { createHash } from "node:crypto";
import { z } from "zod";
import { authCookiePrefix } from "./identity.ts";
import { networkBucket } from "./alias-limits.ts";

/**
 * Every pair, duplicates included. Names are trimmed with `String.trim`, like
 * the better-call parser Better Auth endpoints read cookies with; it removes
 * more than HTTP whitespace (e.g. U+00A0), so a disguised name is still seen.
 */
const cookiePairs = (cookie: string | undefined) =>
  (cookie ?? "").split(";").flatMap((part): [string, string][] => {
    const eq = part.indexOf("=");
    return eq === -1
      ? []
      : [[part.slice(0, eq).trim(), part.slice(eq + 1).trim()]];
  });
export const hasPendingFactor = (cookie: string | undefined) =>
  cookiePairs(cookie).some(
    ([name, value]) =>
      name === `${authCookiePrefix}.two_factor` && value !== "",
  );
export const hasTrustDevice = (cookie: string | undefined) =>
  cookiePairs(cookie).some(
    ([name]) => name === `${authCookiePrefix}.trust_device`,
  );
export const withoutSessionCookie = (cookie: string) =>
  cookie
    .split(";")
    .filter(
      (part) =>
        !cookiePairs(part).some(
          ([name]) => name === `${authCookiePrefix}.session_token`,
        ),
    )
    .join(";");

const EmailBody = z.object({ email: z.email() });
const emailFromBody = (body: unknown): string | undefined => {
  const parsed = EmailBody.safeParse(body);
  return parsed.success ? parsed.data.email.toLowerCase() : undefined;
};
const challengeValues = (cookie: string | undefined) =>
  cookiePairs(cookie)
    .filter(([name]) => name === `${authCookiePrefix}.two_factor`)
    .map(([name, value]) => `${name}=${value}`);
const challengeCookie = (cookie: string | undefined): string | undefined => {
  const values = challengeValues(cookie);
  const value = values.length === 1 ? values[0] : undefined;
  return value === undefined
    ? undefined
    : createHash("sha256").update(value).digest("hex");
};

const cookieNames = (cookie: string | undefined) =>
  cookiePairs(cookie).map(([name]) => name);
/** Two values for one authentication cookie mean a planted cookie. */
export const hasDuplicateAuthCookie = (cookie: string | undefined) => {
  const names = cookieNames(cookie).filter((name) =>
    name.startsWith(`${authCookiePrefix}.`),
  );
  return new Set(names).size !== names.length;
};
/** Cookies from the previous `__Secure-` naming, ignored and then cleared. */
export const legacyAuthCookies = (cookie: string | undefined) => [
  ...new Set(
    cookieNames(cookie).filter((name) =>
      name.startsWith("__Secure-better-auth."),
    ),
  ),
];

/** In-memory single-node limits. State resets on restart and is not shared. */
export const createAuthLimiter = (now: () => number = Date.now) => {
  const ipBuckets = createFixedWindow(now, 10_000, true);
  const accountBuckets = createFixedWindow(now, 10_000, true);
  const reauthBuckets = createFixedWindow(now, 10_000, true);
  const challenges = new Map<string, { email: string; until: number }>();
  return {
    reauthenticate(path: string, userId: string | undefined) {
      if (
        userId === undefined ||
        ![
          "/auth/security-keys/register-options",
          "/auth/security-keys/remove",
          "/auth/two-factor/enable",
          "/auth/two-factor/disable",
          "/auth/two-factor/get-totp-uri",
          "/auth/two-factor/generate-backup-codes",
          "/auth/change-password",
        ].includes(path)
      )
        return undefined;
      // One budget for every password re-check: enough for a user setting up
      // several factors in a minute, too small to guess from many addresses.
      return reauthBuckets.consume(`reauth:${userId}`, 10);
    },
    hasDuplicateChallenge: (cookie: string | undefined) =>
      challengeValues(cookie).length > 1,
    account(body: unknown, cookie: string | undefined): string | undefined {
      const token = challengeCookie(cookie);
      const challenge = token === undefined ? undefined : challenges.get(token);
      return (
        (challenge !== undefined && challenge.until > now()
          ? challenge.email
          : undefined) ?? emailFromBody(body)
      );
    },
    check(path: string, ip: string, body: unknown, cookie: string | undefined) {
      const isSignIn = path === "/auth/sign-in/email";
      const isMfa =
        path === "/auth/two-factor/verify-totp" ||
        path === "/auth/two-factor/verify-security-key" ||
        path === "/auth/two-factor/verify-backup-code";
      const current = now();
      for (const [key, value] of challenges)
        if (value.until <= current) challenges.delete(key);
      const token = challengeCookie(cookie);
      const account = isMfa
        ? token === undefined
          ? undefined
          : challenges.get(token)?.email
        : emailFromBody(body);
      const category = isSignIn
        ? "login"
        : isMfa
          ? "mfa"
          : path === "/auth/sign-up/email"
            ? "signup"
            : "auth";
      const normalizedIp = networkBucket(ip);
      const ipWait = ipBuckets.consume(
        `${category}:ip:${normalizedIp}`,
        isSignIn || isMfa ? 50 : category === "signup" ? 10 : 100,
      );
      if (ipWait !== undefined) return { ...ipWait, bucket: "ip" as const };
      const accountWait =
        account === undefined
          ? undefined
          : accountBuckets.consume(
              isSignIn || isMfa
                ? `${category}:account:${account}`
                : `${category}:account:${normalizedIp}:${account}`,
              isSignIn || isMfa ? 5 : 20,
            );
      return accountWait === undefined
        ? undefined
        : { ...accountWait, bucket: "account" as const };
    },
    remember(body: unknown, cookies: string[]): void {
      const email = emailFromBody(body);
      if (email === undefined) return;
      for (const cookie of cookies) {
        const token = challengeCookie(cookie);
        if (token !== undefined)
          challenges.set(token, { email, until: now() + 600_000 });
      }
    },
  };
};
