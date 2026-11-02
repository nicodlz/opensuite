import { z } from "zod";
import type { AuthRequestContext } from "./auth-context.ts";
import { legacyAuthCookies } from "./limits.ts";

async function auditAuthResponse(
  context: AuthRequestContext,
  response: Response,
  auditUserId: string | null,
) {
  const { identity, path } = context;
  const actions: Readonly<Record<string, string>> = {
    "/auth/sign-up/email": "sign_up",
    "/auth/sign-in/email": "sign_in",
    "/auth/two-factor/enable": "mfa.enrol",
    "/auth/two-factor/verify-totp": "mfa.verify",
    "/auth/two-factor/verify-backup-code": "mfa.verify",
    "/auth/two-factor/verify-security-key": "mfa.verify",
    "/auth/security-keys/register": "mfa.key.add",
    "/auth/security-keys/register-options": "mfa.key.enrol_options",
    "/auth/security-keys/remove": "mfa.key.remove",
    "/auth/two-factor/disable": "mfa.totp.remove",
    "/auth/two-factor/generate-backup-codes": "mfa.backup_codes.regenerate",
    "/auth/revoke-session": "session.revoke",
    "/auth/revoke-sessions": "session.revoke_all",
    "/auth/revoke-other-sessions": "session.revoke_others",
    "/auth/sign-out": "session.revoke",
  };
  const action = actions[path];
  if (action !== undefined) {
    const responseBody: unknown = await response
      .clone()
      .json()
      .catch(() => null);
    const challenge =
      typeof responseBody === "object" &&
      responseBody !== null &&
      "twoFactorRedirect" in responseBody &&
      responseBody.twoFactorRedirect === true;
    await identity.audit?.({
      userId: auditUserId,
      // Better Auth applies its own per-IP limit (3 sign-ins per 10 s
      // in production); a refusal there is not a wrong password.
      action: `${action}.${response.ok ? (challenge ? "challenge" : "success") : response.status === 429 ? "rate_limited" : "failure"}`,
    });
    await auditFactorChanges(context, response, auditUserId, responseBody);
  }
}

async function auditFactorChanges(
  context: AuthRequestContext,
  response: Response,
  auditUserId: string | null,
  responseBody: unknown,
) {
  const { identity, path } = context;
  if (
    response.ok &&
    path === "/auth/security-keys/register" &&
    z
      .object({ backupCodes: z.array(z.string()).min(1) })
      .safeParse(responseBody).success
  )
    await identity.audit?.({
      userId: auditUserId,
      action: "mfa.enrol.success",
    });
  if (
    response.ok &&
    (path === "/auth/security-keys/remove" ||
      path === "/auth/two-factor/disable") &&
    z.object({ twoFactorEnabled: z.literal(false) }).safeParse(responseBody)
      .success
  )
    await identity.audit?.({
      userId: auditUserId,
      action: "mfa.disable.success",
    });
}

export async function sendAuthResponse(
  context: AuthRequestContext,
  response: Response,
) {
  const {
    request,
    reply,
    limiter,
    path,
    pendingFactor,
    authBody,
    actor,
    resolvedUserId,
    accountUserId,
  } = context;
  const auditUserId = actor?.id ?? resolvedUserId ?? accountUserId;
  void reply.code(response.status);
  for (const [name, value] of response.headers) {
    if (name !== "set-cookie" && name !== "content-length")
      void reply.header(name, value);
  }
  const cookies = response.headers.getSetCookie();
  if (path === "/auth/sign-out" && pendingFactor)
    cookies.push(
      "__Host-opensuite.two_factor=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Lax",
    );
  if (path === "/auth/sign-in/email") limiter.remember(authBody, cookies);
  await auditAuthResponse(context, response, auditUserId);
  // Clear cookies left by the previous naming on this host. A cookie
  // planted for a parent domain is ignored by name and left alone.
  for (const name of legacyAuthCookies(request.headers.cookie))
    cookies.push(`${name}=; Max-Age=0; Path=/; Secure; HttpOnly`);
  if (cookies.length > 0) void reply.header("set-cookie", cookies);
  // Never hand the session token itself to page scripts.
  if (path === "/auth/one-time-token/verify")
    return reply.send(response.ok ? { success: true } : null);
  return reply.send(await response.text());
}
