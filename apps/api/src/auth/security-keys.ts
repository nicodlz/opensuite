import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  APIError,
  createAuthEndpoint,
  sessionMiddleware,
} from "better-auth/api";
import { expireCookie, setSessionCookie } from "better-auth/cookies";
import { symmetricDecrypt, symmetricEncrypt } from "better-auth/crypto";
import type { PrismaClient } from "@opensuite/db";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticatorTransportFuture,
} from "@simplewebauthn/server";
import { z } from "zod";

const invalid = () =>
  new APIError("UNAUTHORIZED", {
    message: "Invalid or expired authentication challenge",
  });
const credentialBase = {
  id: z.string(),
  rawId: z.string(),
  type: z.literal("public-key"),
  clientExtensionResults: z.object({}),
  authenticatorAttachment: z.enum(["platform", "cross-platform"]).optional(),
};
const registrationResponse = z.object({
  ...credentialBase,
  response: z.object({
    clientDataJSON: z.string(),
    attestationObject: z.string(),
    transports: z
      .array(
        z.enum([
          "usb",
          "nfc",
          "ble",
          "internal",
          "hybrid",
          "smart-card",
          "cable",
        ]),
      )
      .optional(),
  }),
});
const input = z.object({
  ...credentialBase,
  response: z.object({
    clientDataJSON: z.string(),
    authenticatorData: z.string(),
    signature: z.string(),
    userHandle: z.string().optional(),
  }),
});
const codeList = () =>
  Array.from({ length: 10 }, () => {
    const value = randomBytes(9).toString("base64url");
    return `${value.slice(0, 6)}-${value.slice(6)}`;
  });
const tokenKey = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const transports = (values: string[]) =>
  values.filter((value): value is AuthenticatorTransportFuture =>
    ["usb", "nfc", "ble", "internal", "hybrid", "smart-card", "cable"].includes(
      value,
    ),
  );

/** Pinned to Better Auth 1.7.13's two-factor challenge cookie and verification rows. */
export function securityKeys(db: PrismaClient, origin: string) {
  const rpID = new URL(origin).hostname;
  const sessionUse = [sessionMiddleware];
  return {
    id: "security-keys",
    endpoints: {
      factorStatus: createAuthEndpoint(
        "/security-keys/status",
        { method: "GET", use: sessionUse },
        async (ctx) => {
          const userId = ctx.context.session.user.id;
          const [factor, keys] = await Promise.all([
            db.twoFactor.findUnique({ where: { userId } }),
            db.securityKey.findMany({
              where: { userId },
              orderBy: { createdAt: "asc" },
              select: {
                id: true,
                name: true,
                createdAt: true,
                lastUsedAt: true,
              },
            }),
          ]);
          const codes: unknown = factor
            ? JSON.parse(
                await symmetricDecrypt({
                  key: ctx.context.secretConfig,
                  data: factor.backupCodes,
                }),
              )
            : [];
          return ctx.json({
            totp: factor?.verified === true,
            keys,
            backupCodesRemaining: Array.isArray(codes) ? codes.length : 0,
          });
        },
      ),
      registrationOptions: createAuthEndpoint(
        "/security-keys/register-options",
        {
          method: "POST",
          use: sessionUse,
          body: z.object({ password: z.string() }),
        },
        async (ctx) => {
          const { user, session } = ctx.context.session;
          await ctx.context.password.checkPassword(user.id, ctx);
          const keys = await db.securityKey.findMany({
            where: { userId: user.id },
          });
          const options = await generateRegistrationOptions({
            rpName: "Esuno",
            rpID,
            userID: new TextEncoder().encode(user.id),
            userName: user.email,
            attestationType: "none",
            authenticatorSelection: {
              residentKey: "discouraged",
              userVerification: "preferred",
            },
            excludeCredentials: keys.map((key) => ({
              id: key.credentialId,
              transports: transports(key.transports),
            })),
          });
          const id = `key-register-${randomBytes(32).toString("base64url")}`;
          await ctx.context.internalAdapter.createVerificationValue({
            identifier: id,
            value: JSON.stringify({
              userId: user.id,
              sessionId: session.id,
              challenge: options.challenge,
            }),
            expiresAt: new Date(Date.now() + 300_000),
          });
          return ctx.json({ id, options });
        },
      ),
      registerKey: createAuthEndpoint(
        "/security-keys/register",
        {
          method: "POST",
          use: sessionUse,
          body: z.object({
            id: z.string(),
            name: z.string().trim().min(1).max(80),
            response: registrationResponse,
          }),
        },
        async (ctx) => {
          const { user, session } = ctx.context.session;
          if (!ctx.body.id.startsWith("key-register-")) throw invalid();
          const row =
            await ctx.context.internalAdapter.consumeVerificationValue(
              ctx.body.id,
            );
          const parsed = z
            .object({
              userId: z.string(),
              sessionId: z.string(),
              challenge: z.string(),
            })
            .safeParse(row ? JSON.parse(row.value) : null);
          if (
            !parsed.success ||
            parsed.data.userId !== user.id ||
            parsed.data.sessionId !== session.id
          )
            throw invalid();
          let verification;
          try {
            const credentialResponse = ctx.body.response;
            const { transports: availableTransports, ...attestation } =
              credentialResponse.response;
            verification = await verifyRegistrationResponse({
              response: {
                id: credentialResponse.id,
                rawId: credentialResponse.rawId,
                type: credentialResponse.type,
                clientExtensionResults: {},
                response: {
                  ...attestation,
                  ...(availableTransports === undefined
                    ? {}
                    : { transports: availableTransports }),
                },
              },
              expectedChallenge: parsed.data.challenge,
              expectedOrigin: origin,
              expectedRPID: rpID,
              requireUserVerification: false,
            });
          } catch {
            throw invalid();
          }
          if (!verification.verified) throw invalid();
          const credential = verification.registrationInfo.credential;
          const backupCodes = codeList();
          const encryptedCodes = await symmetricEncrypt({
            key: ctx.context.secretConfig,
            data: JSON.stringify(backupCodes),
          });
          const secret = await symmetricEncrypt({
            key: ctx.context.secretConfig,
            data: randomBytes(24).toString("base64url"),
          });
          const first = await db.$transaction(async (tx) => {
            await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${user.id} FOR UPDATE`;
            const existing = await tx.twoFactor.findUnique({
              where: { userId: user.id },
            });
            const count = await tx.securityKey.count({
              where: { userId: user.id },
            });
            const hasFactor = existing?.verified === true || count > 0;
            await tx.securityKey.create({
              data: {
                userId: user.id,
                name: ctx.body.name,
                credentialId: credential.id,
                publicKey: Buffer.from(credential.publicKey),
                counter: BigInt(credential.counter),
                transports: credential.transports ?? [],
              },
            });
            if (!hasFactor) {
              if (existing)
                await tx.twoFactor.update({
                  where: { userId: user.id },
                  data: {
                    secret,
                    backupCodes: encryptedCodes,
                    verified: false,
                  },
                });
              else
                await tx.twoFactor.create({
                  data: {
                    id: randomUUID(),
                    userId: user.id,
                    secret,
                    backupCodes: encryptedCodes,
                    verified: false,
                  },
                });
            }
            await tx.user.update({
              where: { id: user.id },
              data: { twoFactorEnabled: true },
            });
            return !hasFactor;
          });
          return ctx.json({ backupCodes: first ? backupCodes : [] });
        },
      ),
      removeKey: createAuthEndpoint(
        "/security-keys/remove",
        {
          method: "POST",
          use: sessionUse,
          body: z.object({ id: z.string(), password: z.string() }),
        },
        async (ctx) => {
          const userId = ctx.context.session.user.id;
          await ctx.context.password.checkPassword(userId, ctx);
          const removed = await db.$transaction(async (tx) => {
            await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${userId} FOR UPDATE`;
            const result = await tx.securityKey.deleteMany({
              where: { id: ctx.body.id, userId },
            });
            if (!result.count) return null;
            const [factor, count] = await Promise.all([
              tx.twoFactor.findUnique({ where: { userId } }),
              tx.securityKey.count({ where: { userId } }),
            ]);
            const enabled = factor?.verified === true || count > 0;
            if (!enabled) await tx.twoFactor.deleteMany({ where: { userId } });
            await tx.user.update({
              where: { id: userId },
              data: { twoFactorEnabled: enabled },
            });
            return { enabled };
          });
          if (!removed)
            throw new APIError("NOT_FOUND", {
              message: "Security key not found",
            });
          return ctx.json({ success: true, twoFactorEnabled: removed.enabled });
        },
      ),
      keyOptions: createAuthEndpoint(
        "/two-factor/security-key-options",
        { method: "POST", body: z.object({}) },
        async (ctx) => {
          const cookie = ctx.context.createAuthCookie("two_factor");
          const token = await ctx.getSignedCookie(
            cookie.name,
            ctx.context.secret,
          );
          if (!token) throw invalid();
          const pending =
            await ctx.context.internalAdapter.findVerificationValue(token);
          if (!pending || pending.expiresAt <= new Date()) throw invalid();
          const keys = await db.securityKey.findMany({
            where: { userId: pending.value },
          });
          if (!keys.length) throw invalid();
          const options = await generateAuthenticationOptions({
            rpID,
            userVerification: "preferred",
            allowCredentials: keys.map((key) => ({
              id: key.credentialId,
              transports: transports(key.transports),
            })),
          });
          const identifier = `key-auth-${tokenKey(token)}`;
          await ctx.context.internalAdapter.consumeVerificationValue(
            identifier,
          );
          await ctx.context.internalAdapter.createVerificationValue({
            identifier,
            value: options.challenge,
            expiresAt: new Date(
              Math.min(pending.expiresAt.getTime(), Date.now() + 300_000),
            ),
          });
          return ctx.json(options);
        },
      ),
      challengeMethods: createAuthEndpoint(
        "/two-factor/methods",
        { method: "POST", body: z.object({}) },
        async (ctx) => {
          const cookie = ctx.context.createAuthCookie("two_factor");
          const token = await ctx.getSignedCookie(
            cookie.name,
            ctx.context.secret,
          );
          const pending = token
            ? await ctx.context.internalAdapter.findVerificationValue(token)
            : null;
          if (!pending || pending.expiresAt <= new Date()) throw invalid();
          const [factor, count] = await Promise.all([
            db.twoFactor.findUnique({ where: { userId: pending.value } }),
            db.securityKey.count({ where: { userId: pending.value } }),
          ]);
          return ctx.json({
            totp: factor?.verified === true,
            securityKey: count > 0,
            backup: factor !== null,
          });
        },
      ),
      verifySecurityKey: createAuthEndpoint(
        "/two-factor/verify-security-key",
        { method: "POST", body: input },
        async (ctx) => {
          const cookie = ctx.context.createAuthCookie("two_factor");
          const token = await ctx.getSignedCookie(
            cookie.name,
            ctx.context.secret,
          );
          if (!token) throw invalid();
          const pending =
            await ctx.context.internalAdapter.findVerificationValue(token);
          if (!pending || pending.expiresAt <= new Date()) throw invalid();
          const challenge =
            await ctx.context.internalAdapter.consumeVerificationValue(
              `key-auth-${tokenKey(token)}`,
            );
          if (!challenge) throw invalid();
          const user = await ctx.context.internalAdapter.findUserById(
            pending.value,
          );
          const factor = await db.twoFactor.findUnique({
            where: { userId: pending.value },
          });
          const account = await db.user.findUnique({
            where: { id: pending.value },
            select: { twoFactorEnabled: true },
          });
          if (
            !user ||
            !account?.twoFactorEnabled ||
            !factor ||
            (factor.lockedUntil && factor.lockedUntil > new Date())
          )
            throw invalid();
          if (factor.lockedUntil)
            await db.twoFactor.updateMany({
              where: { userId: user.id, lockedUntil: { lte: new Date() } },
              data: { failedVerificationCount: 0, lockedUntil: null },
            });
          const attempts =
            await ctx.context.internalAdapter.consumeVerificationValue(
              `2fa-attempts-${token}`,
            );
          if (!attempts) throw invalid();
          const count = Number(attempts.value);
          if (!Number.isInteger(count) || count < 0 || count >= 5) {
            await ctx.context.internalAdapter.consumeVerificationValue(token);
            expireCookie(ctx, cookie);
            throw invalid();
          }
          const fail = async () => {
            await ctx.context.internalAdapter.createVerificationValue({
              identifier: `2fa-attempts-${token}`,
              value: String(count + 1),
              expiresAt: pending.expiresAt,
            });
            await db.$executeRaw`UPDATE "TwoFactor" SET "failedVerificationCount" = "failedVerificationCount" + 1, "lockedUntil" = CASE WHEN "failedVerificationCount" + 1 >= 10 THEN NOW() + INTERVAL '15 minutes' ELSE "lockedUntil" END WHERE "userId" = ${user.id}`;
            throw invalid();
          };
          const key = await db.securityKey.findFirst({
            where: { userId: user.id, credentialId: ctx.body.id },
          });
          if (!key) return fail();
          let verification;
          try {
            const { userHandle, ...assertion } = ctx.body.response;
            verification = await verifyAuthenticationResponse({
              response: {
                id: ctx.body.id,
                rawId: ctx.body.rawId,
                type: ctx.body.type,
                clientExtensionResults: {},
                response: {
                  ...assertion,
                  ...(userHandle === undefined ? {} : { userHandle }),
                },
              },
              expectedChallenge: challenge.value,
              expectedOrigin: origin,
              expectedRPID: rpID,
              requireUserVerification: false,
              credential: {
                id: key.credentialId,
                publicKey: new Uint8Array(key.publicKey),
                counter: Number(key.counter),
                transports: transports(key.transports),
              },
            });
          } catch {
            return fail();
          }
          if (!verification.verified) return fail();
          const dontRemember = await ctx.getSignedCookie(
            ctx.context.authCookies.dontRememberToken.name,
            ctx.context.secret,
          );
          const session = await db.$transaction(async (tx) => {
            // Serialize with factor removal without blocking the session FK check.
            await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${user.id} FOR NO KEY UPDATE`;
            const current = await tx.user.findUnique({
              where: { id: user.id },
              select: { twoFactorEnabled: true },
            });
            if (!current?.twoFactorEnabled) throw invalid();
            const updated = await tx.securityKey.updateMany({
              where: { id: key.id, userId: user.id, counter: key.counter },
              data: {
                counter: BigInt(verification.authenticationInfo.newCounter),
                lastUsedAt: new Date(),
              },
            });
            if (updated.count !== 1) throw invalid();
            const consumed =
              await ctx.context.internalAdapter.consumeVerificationValue(token);
            if (!consumed || consumed.value !== user.id) throw invalid();
            await tx.twoFactor.updateMany({
              where: { userId: user.id },
              data: { failedVerificationCount: 0, lockedUntil: null },
            });
            return ctx.context.internalAdapter.createSession(
              user.id,
              !!dontRemember,
            );
          });
          // Better Auth's session-create hook can reject issuance despite its non-null type.
          // oxlint-disable-next-line typescript/no-unnecessary-condition
          if (!session)
            throw new APIError("INTERNAL_SERVER_ERROR", {
              message: "Failed to create session",
            });
          await setSessionCookie(ctx, { session, user });
          expireCookie(ctx, cookie);
          return ctx.json({ success: true });
        },
      ),
    },
  };
}

/** Override Better Auth's all-factor disable so removing TOTP preserves keys. */
export function disableAuthenticator(db: PrismaClient) {
  return createAuthEndpoint(
    "/two-factor/disable",
    {
      method: "POST",
      use: [sessionMiddleware],
      body: z.object({ password: z.string() }),
    },
    async (ctx) => {
      const userId = ctx.context.session.user.id;
      await ctx.context.password.checkPassword(userId, ctx);
      await db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${userId} FOR UPDATE`;
        const keys = await tx.securityKey.count({ where: { userId } });
        if (keys)
          await tx.twoFactor.updateMany({
            where: { userId },
            data: { verified: false },
          });
        else await tx.twoFactor.deleteMany({ where: { userId } });
        await tx.user.update({
          where: { id: userId },
          data: { twoFactorEnabled: keys > 0 },
        });
      });
      return ctx.json({ status: true });
    },
  );
}
