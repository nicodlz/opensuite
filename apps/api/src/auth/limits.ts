import { createHash } from "node:crypto";
import { z } from "zod";

type Bucket = { count: number; until: number };
const EmailBody = z.object({ email: z.email() });
const emailFromBody = (body: unknown): string | undefined => {
  const parsed = EmailBody.safeParse(body);
  return parsed.success ? parsed.data.email.toLowerCase() : undefined;
};
const challengeValues = (cookie: string | undefined) =>
  (cookie ?? "")
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.split("=")[0] === "__Secure-better-auth.two_factor");
const challengeCookie = (cookie: string | undefined): string | undefined => {
  const values = challengeValues(cookie);
  const value = values.length === 1 ? values[0] : undefined;
  return value === undefined
    ? undefined
    : createHash("sha256").update(value).digest("hex");
};

/** In-memory single-node limits. State resets on restart and is not shared. */
export const createAuthLimiter = (now: () => number = Date.now) => {
  const buckets = new Map<string, Bucket>();
  const challenges = new Map<string, { email: string; until: number }>();
  const windowMs = 60_000;
  const consume = (key: string, max: number) => {
    const current = now();
    const existing = buckets.get(key);
    const bucket =
      existing === undefined || existing.until <= current
        ? { count: 0, until: current + windowMs }
        : existing;
    bucket.count += 1;
    buckets.set(key, bucket);
    return bucket.count > max
      ? {
          retryAfter: Math.max(1, Math.ceil((bucket.until - current) / 1000)),
          first: bucket.count === max + 1,
        }
      : undefined;
  };
  return {
    hasDuplicateChallenge: (cookie: string | undefined) =>
      challengeValues(cookie).length > 1,
    account(body: unknown, cookie: string | undefined): string | undefined {
      const token = challengeCookie(cookie);
      const challenge = token === undefined ? undefined : challenges.get(token);
      return (
        emailFromBody(body) ??
        (challenge !== undefined && challenge.until > now()
          ? challenge.email
          : undefined)
      );
    },
    check(path: string, ip: string, body: unknown, cookie: string | undefined) {
      const isSignIn = path === "/auth/sign-in/email";
      const isMfa =
        path === "/auth/two-factor/verify-totp" ||
        path === "/auth/two-factor/verify-backup-code";
      const current = now();
      for (const [key, value] of buckets)
        if (value.until <= current) buckets.delete(key);
      for (const [key, value] of challenges)
        if (value.until <= current) challenges.delete(key);
      const token = challengeCookie(cookie);
      const account =
        emailFromBody(body) ??
        (token === undefined ? undefined : challenges.get(token)?.email);
      const category = isSignIn
        ? "login"
        : isMfa
          ? "mfa"
          : path === "/auth/sign-up/email"
            ? "signup"
            : "auth";
      const ipWait = consume(
        `${category}:ip:${ip}`,
        isSignIn || isMfa ? 50 : category === "signup" ? 10 : 100,
      );
      if (ipWait !== undefined) return ipWait;
      const accountWait =
        account === undefined
          ? undefined
          : consume(
              `${category}:account:${ip}:${account}`,
              isSignIn || isMfa ? 5 : 20,
            );
      return accountWait;
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
