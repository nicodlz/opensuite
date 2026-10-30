import type { AuthClient } from "../auth/client.ts";

// Synthetic credentials are available only in the development bundle.
const signedOut = () =>
  sessionStorage.getItem("auth-fixture-signed-out") === "1";
const mfa = () => sessionStorage.getItem("auth-fixture-mfa") === "1";
export const fakeAuth: AuthClient = {
  session: () =>
    Promise.resolve(
      signedOut()
        ? null
        : { user: { email: "you@example.test", twoFactorEnabled: mfa() } },
    ),
  signIn(email, password) {
    if (email !== "you@example.test" || password !== "synthetic-password")
      return Promise.reject(new Error("Incorrect email or password."));
    if (mfa()) return Promise.resolve({ twoFactorRedirect: true });
    sessionStorage.removeItem("auth-fixture-signed-out");
    return Promise.resolve({});
  },
  verify(code, backup) {
    if (code !== (backup ? "backup-code" : "123456"))
      return Promise.reject(new Error("Invalid verification code."));
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
    sessionStorage.setItem("auth-fixture-enrolling", "1");
    return Promise.resolve({
      totpURI:
        "otpauth://totp/OpenSuite:you@example.test?secret=JBSWY3DPEHPK3PXP&issuer=OpenSuite",
      backupCodes: ["backup-code"],
    });
  },
  disable(password) {
    if (password !== "synthetic-password")
      return Promise.reject(new Error("Incorrect password."));
    sessionStorage.removeItem("auth-fixture-mfa");
    return Promise.resolve();
  },
};
