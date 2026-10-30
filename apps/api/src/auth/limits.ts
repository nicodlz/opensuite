import { z } from "zod";
import { createHash } from "node:crypto";

type Bucket = { count: number; until: number };
const EmailBody = z.object({ email: z.email() });
const emailFromBody = (body: unknown): string | undefined => {
  const parsed = EmailBody.safeParse(body);
  return parsed.success ? parsed.data.email.toLowerCase() : undefined;
};
const challengeCookie = (cookie: string | undefined): string | undefined => {
  const value = cookie
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.split("=")[0]?.endsWith(".two_factor") === true);
  return value === undefined
    ? undefined
    : createHash("sha256").update(value).digest("hex");
};

/** In-memory single-node limits. State resets on restart and is not shared. */
export const createAuthLimiter = (now: () => number = Date.now) => {
  const buckets = new Map<string, Bucket>();
  const challenges = new Map<string, { email: string; until: number }>();
  const windowMs = 60_000;
  const consume = (key: string, max: number): number | undefined => {
    const current = now();
    const existing = buckets.get(key);
    const bucket =
      existing === undefined || existing.until <= current
        ? { count: 0, until: current + windowMs }
        : existing;
    bucket.count += 1;
    buckets.set(key, bucket);
    return bucket.count > max
      ? Math.max(1, Math.ceil((bucket.until - current) / 1000))
      : undefined;
  };
  return {
    account(
      body: unknown,
      cookie: string | undefined,
      actorEmail?: string,
    ): string | undefined {
      const token = challengeCookie(cookie);
      const challenge = token === undefined ? undefined : challenges.get(token);
      return (
        actorEmail ??
        emailFromBody(body) ??
        (challenge !== undefined && challenge.until > now()
          ? challenge.email
          : undefined)
      );
    },
    check(
      path: string,
      ip: string,
      body: unknown,
      cookie: string | undefined,
      actorEmail?: string,
    ): number | undefined {
      const isSignIn = path === "/auth/sign-in/email";
      const isMfa =
        path === "/auth/two-factor/verify-totp" ||
        path === "/auth/two-factor/verify-backup-code";
      if (!isSignIn && !isMfa) return undefined;
      const current = now();
      for (const [key, value] of buckets)
        if (value.until <= current) buckets.delete(key);
      for (const [key, value] of challenges)
        if (value.until <= current) challenges.delete(key);
      const token = challengeCookie(cookie);
      const account = isSignIn
        ? emailFromBody(body)
        : (actorEmail ??
          (token === undefined ? undefined : challenges.get(token)?.email));
      const ipWait = consume(`${isSignIn ? "login" : "mfa"}:ip:${ip}`, 50);
      const accountWait =
        account === undefined
          ? undefined
          : consume(
              `${isSignIn ? "login" : "mfa"}:account:${account.toLowerCase()}`,
              5,
            );
      if (ipWait === undefined) return accountWait;
      return accountWait === undefined ? ipWait : Math.max(ipWait, accountWait);
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
