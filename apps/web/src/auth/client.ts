import { z } from "zod";
import {
  startAuthentication,
  startRegistration,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/browser";

const SessionSchema = z.object({
  user: z.object({
    email: z.email(),
    twoFactorEnabled: z.boolean().optional(),
  }),
});
export const hasWebAuthn = () =>
  typeof Reflect.get(globalThis, "PublicKeyCredential") === "function";
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
    async factors() {
      return z
        .object({
          totp: z.boolean(),
          backupCodesRemaining: z.number(),
          keys: z.array(
            z.object({
              id: z.string(),
              name: z.string(),
              createdAt: z.string(),
              lastUsedAt: z.string().nullable(),
            }),
          ),
        })
        .parse(await request("security-keys/status"));
    },
    async methods() {
      return z
        .object({
          totp: z.boolean(),
          securityKey: z.boolean(),
          backup: z.boolean(),
        })
        .parse(await request("two-factor/methods", {}));
    },
    async addKey(password: string, name: string) {
      if (!hasWebAuthn())
        throw new Error("Security keys are not supported by this browser.");
      const data = z
        .object({
          id: z.string(),
          options: z.custom<PublicKeyCredentialCreationOptionsJSON>(),
        })
        .parse(await request("security-keys/register-options", { password }));
      const response = await startRegistration({ optionsJSON: data.options });
      return z.object({ backupCodes: z.array(z.string()) }).parse(
        await request("security-keys/register", {
          id: data.id,
          name,
          response,
        }),
      ).backupCodes;
    },
    async removeKey(id: string, password: string) {
      await request("security-keys/remove", { id, password });
    },
    async verifyKey() {
      if (!hasWebAuthn())
        throw new Error("Security keys are not supported by this browser.");
      const options = z
        .custom<PublicKeyCredentialRequestOptionsJSON>()
        .parse(await request("two-factor/security-key-options", {}));
      const response = await startAuthentication({ optionsJSON: options });
      await request("two-factor/verify-security-key", response);
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
