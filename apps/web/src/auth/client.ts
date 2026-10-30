import { z } from "zod";

const SessionSchema = z.object({
  user: z.object({
    email: z.email(),
    twoFactorEnabled: z.boolean().optional(),
  }),
});
export class AuthError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
export function createAuthClient(fetcher: typeof fetch = fetch) {
  async function request(path: string, body?: object): Promise<unknown> {
    const response = await fetcher(`/api/auth/${path}`, {
      method: body === undefined ? "GET" : "POST",
      credentials: "same-origin",
      ...(body === undefined
        ? {}
        : {
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          }),
    });
    const data: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const parsed = z.object({ message: z.string() }).safeParse(data);
      throw new AuthError(
        response.status,
        parsed.success ? parsed.data.message : "Authentication request failed.",
      );
    }
    return data;
  }
  return {
    async session() {
      return SessionSchema.nullable().parse(await request("get-session"));
    },
    async signIn(email: string, password: string) {
      return z
        .object({ twoFactorRedirect: z.boolean().optional() })
        .parse(await request("sign-in/email", { email, password }));
    },
    async verify(code: string, backup: boolean) {
      await request(
        backup ? "two-factor/verify-backup-code" : "two-factor/verify-totp",
        { code },
      );
    },
    async signOut() {
      await request("sign-out", {});
    },
    async enable(password: string) {
      return z
        .object({ totpURI: z.string(), backupCodes: z.array(z.string()) })
        .parse(await request("two-factor/enable", { password }));
    },
    async disable(password: string) {
      await request("two-factor/disable", { password });
    },
    async regenerateBackupCodes(password: string) {
      return z
        .object({ backupCodes: z.array(z.string()) })
        .parse(await request("two-factor/generate-backup-codes", { password }))
        .backupCodes;
    },
    /** Asks the sign-in origin for a token valid on one sibling origin. */
    async handoff(target: string) {
      const response = await fetcher("/api/session/handoff", {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target }),
      });
      if (!response.ok)
        throw new AuthError(response.status, "Could not continue sign-in.");
      return z.object({ token: z.string() }).parse(await response.json()).token;
    },
    async redeem(token: string) {
      await request("one-time-token/verify", { token });
    },
  };
}
const live = createAuthClient();
export type AuthClient = typeof live;
export const auth: AuthClient = import.meta.env.DEV
  ? (await import("../dev-data/auth.ts")).fakeAuth
  : live;
