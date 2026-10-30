import type { AuthClient } from "../auth/client.ts";
import { z } from "zod";

// Synthetic credentials are available only in the development bundle.
const signedOut = () =>
  sessionStorage.getItem("auth-fixture-signed-out") === "1";
const mfa = () => sessionStorage.getItem("auth-fixture-mfa") === "1";
const keys = () =>
  z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        createdAt: z.string(),
        lastUsedAt: z.string().nullable(),
      }),
    )
    .parse(JSON.parse(sessionStorage.getItem("auth-fixture-keys") ?? "[]"));
const enabled = () => mfa() || keys().length > 0;
export const fakeAuth: AuthClient = {
  session: () =>
    Promise.resolve(
      signedOut()
        ? null
        : { user: { email: "you@example.test", twoFactorEnabled: enabled() } },
    ),
  signIn(email, password) {
    const extra: unknown = JSON.parse(
      sessionStorage.getItem("address-fixture-items") ?? "[]",
    );
    const matches = z.array(z.object({ address: z.string() })).safeParse(extra);
    if (
      (email.toLowerCase() !== "you@example.test" &&
        !(
          matches.success &&
          matches.data.some(
            (row) => row.address.toLowerCase() === email.toLowerCase(),
          )
        )) ||
      password !== "synthetic-password"
    )
      return Promise.reject(new Error("Incorrect email or password."));
    if (enabled()) return Promise.resolve({ twoFactorRedirect: true });
    sessionStorage.removeItem("auth-fixture-signed-out");
    return Promise.resolve({});
  },
  verify(code, backup) {
    if (
      code !==
      (backup ? sessionStorage.getItem("auth-fixture-backup-code") : "123456")
    )
      return Promise.reject(new Error("Invalid verification code."));
    if (backup) sessionStorage.removeItem("auth-fixture-backup-code");
    if (sessionStorage.getItem("auth-fixture-enrolling") === "1") {
      sessionStorage.setItem("auth-fixture-mfa", "1");
      sessionStorage.removeItem("auth-fixture-enrolling");
    }
    sessionStorage.removeItem("auth-fixture-signed-out");
    return Promise.resolve();
  },
  signOut() {
    sessionStorage.setItem("auth-fixture-signed-out", "1");
    return Promise.resolve();
  },
  enable(password) {
    if (password !== "synthetic-password")
      return Promise.reject(new Error("Incorrect password."));
    if (mfa())
      return Promise.reject(new Error("Authenticator already enabled."));
    sessionStorage.setItem("auth-fixture-enrolling", "1");
    if (!keys().length)
      sessionStorage.setItem("auth-fixture-backup-code", "backup-code");
    return Promise.resolve({
      totpURI:
        "otpauth://totp/Esuno:you@example.test?secret=JBSWY3DPEHPK3PXP&issuer=Esuno",
      backupCodes: [
        sessionStorage.getItem("auth-fixture-backup-code") ?? "backup-code",
      ],
    });
  },
  disable(password) {
    if (password !== "synthetic-password")
      return Promise.reject(new Error("Incorrect password."));
    sessionStorage.removeItem("auth-fixture-mfa");
    if (!keys().length) sessionStorage.removeItem("auth-fixture-backup-code");
    return Promise.resolve();
  },
  regenerateBackupCodes(password) {
    if (password !== "synthetic-password")
      return Promise.reject(new Error("Incorrect password."));
    if (!enabled())
      return Promise.reject(
        new Error("Two-factor authentication is not enabled."),
      );
    const code = `backup-${crypto.randomUUID()}`;
    sessionStorage.setItem("auth-fixture-backup-code", code);
    return Promise.resolve([code]);
  },
  factors: () =>
    Promise.resolve({
      totp: mfa(),
      backupCodesRemaining: sessionStorage.getItem("auth-fixture-backup-code")
        ? 1
        : 0,
      keys: keys(),
    }),
  methods: () =>
    Promise.resolve({
      totp: mfa(),
      securityKey: keys().length > 0,
      backup: enabled(),
    }),
  addKey(password, name) {
    if (password !== "synthetic-password")
      return Promise.reject(new Error("Incorrect password."));
    const first = !enabled();
    sessionStorage.setItem(
      "auth-fixture-keys",
      JSON.stringify([
        ...keys(),
        {
          id: crypto.randomUUID(),
          name,
          createdAt: new Date().toISOString(),
          lastUsedAt: null,
        },
      ]),
    );
    if (first && !sessionStorage.getItem("auth-fixture-backup-code"))
      sessionStorage.setItem("auth-fixture-backup-code", "backup-code");
    return Promise.resolve(first ? ["backup-code"] : []);
  },
  removeKey(id, password) {
    if (password !== "synthetic-password")
      return Promise.reject(new Error("Incorrect password."));
    if (!keys().some((key) => key.id === id))
      return Promise.reject(new Error("Security key not found."));
    sessionStorage.setItem(
      "auth-fixture-keys",
      JSON.stringify(keys().filter((key) => key.id !== id)),
    );
    if (!enabled()) sessionStorage.removeItem("auth-fixture-backup-code");
    return Promise.resolve();
  },
  verifyKey() {
    if (!keys().length)
      return Promise.reject(new Error("No security key is registered."));
    sessionStorage.removeItem("auth-fixture-signed-out");
    return Promise.resolve();
  },
  handoff: () =>
    signedOut()
      ? Promise.reject(new Error("Signed out"))
      : Promise.resolve("synthetic-handoff-token-0000000000"),
  redeem(token) {
    if (token !== "synthetic-handoff-token-0000000000")
      return Promise.reject(new Error("Invalid or expired sign-in link"));
    sessionStorage.removeItem("auth-fixture-signed-out");
    return Promise.resolve();
  },
};
