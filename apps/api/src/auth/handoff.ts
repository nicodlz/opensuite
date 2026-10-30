import { createHash } from "node:crypto";

const key = (token: string) => createHash("sha256").update(token).digest("hex");

/**
 * Binds each single-use session token to the one application origin it was
 * issued for. Better Auth enforces expiry and single use of the token itself;
 * this registry additionally refuses redemption from any other origin.
 */
export const createHandoffRegistry = (
  now: () => number = Date.now,
  lifetimeMs = 60_000,
) => {
  const entries = new Map<string, { target: string; expires: number }>();
  const sweep = () => {
    const current = now();
    for (const [name, entry] of entries)
      if (entry.expires <= current) entries.delete(name);
  };
  return {
    bind(token: string, target: string) {
      sweep();
      if (entries.size >= 10_000) {
        const oldest = entries.keys().next().value;
        if (oldest !== undefined) entries.delete(oldest);
      }
      entries.set(key(token), { target, expires: now() + lifetimeMs });
    },
    /** Consumes the binding whatever the outcome, so a token is tried once. */
    consume(token: string, origin: string) {
      const name = key(token);
      const entry = entries.get(name);
      entries.delete(name);
      return (
        entry !== undefined && entry.expires > now() && entry.target === origin
      );
    },
  };
};
