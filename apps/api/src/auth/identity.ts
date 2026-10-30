import { AsyncLocalStorage } from "node:async_hooks";
import { generateId } from "@better-auth/core/utils/id";
import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { oneTimeToken, twoFactor } from "better-auth/plugins";
import type { PrismaClient } from "@opensuite/db";
import {
  disableAuthenticator,
  enableAuthenticator,
  securityKeys,
} from "./security-keys.ts";

/**
 * `__Host-` cookies cannot carry a Domain attribute, so a sibling subdomain
 * cannot plant a cookie of the same name for these origins (RFC 6265bis
 * section 4.1.3.2). Better Auth only adds `__Secure-` itself, hence the
 * explicit prefix with its own secure-cookie switch off and Secure forced.
 */
export const authCookiePrefix = "__Host-opensuite";

/** Trusted composition supplies an adapter and lifecycle callbacks. */
export interface IdentityDependencies {
  readonly database: PrismaClient;
  readonly publicOrigin: string;
  /** Exact origins of the mail, drive and calendar applications. */
  readonly trustedOrigins?: readonly string[];
  readonly secret: string;
  readonly provision: (user: { id: string; email: string }) => Promise<void>;
  readonly mayStartSession: (userId: string) => Promise<boolean>;
}

export const createIdentity = (dependencies: IdentityDependencies) => {
  const claimId = new AsyncLocalStorage<string>();
  const totp = twoFactor();
  const build = (disableSignUp: boolean) =>
    betterAuth({
      appName: "Esuno",
      baseURL: dependencies.publicOrigin,
      basePath: "/api/auth",
      secret: dependencies.secret,
      database: prismaAdapter(dependencies.database, {
        provider: "postgresql",
        transaction: true,
      }),
      trustedOrigins: [
        ...new Set([
          dependencies.publicOrigin,
          ...(dependencies.trustedOrigins ?? []),
        ]),
      ],
      // Provisioning runs after the user transaction commits. A session is only
      // issued by a later sign-in after the mailbox link has been checked.
      emailAndPassword: {
        enabled: true,
        disableSignUp,
        minPasswordLength: 12,
        autoSignIn: false,
      },
      // Sibling applications receive the signed-in session through a
      // single-use, one-minute token; cookies stay host-only on each origin.
      plugins: [
        {
          ...totp,
          endpoints: {
            ...totp.endpoints,
            enableTwoFactor: enableAuthenticator(dependencies.database),
            disableTwoFactor: disableAuthenticator(dependencies.database),
          },
        },
        securityKeys(
          dependencies.database,
          dependencies.publicOrigin,
          dependencies.mayStartSession,
        ),
        oneTimeToken({ expiresIn: 1, storeToken: "hashed" }),
      ],
      advanced: {
        database: {
          generateId: ({ model }) =>
            model === "user"
              ? (claimId.getStore() ?? generateId())
              : generateId(),
        },
        useSecureCookies: false,
        cookiePrefix: authCookiePrefix,
        defaultCookieAttributes: {
          httpOnly: true,
          secure: true,
          sameSite: "lax",
          path: "/",
        },
      },
      databaseHooks: {
        user: {
          create: {
            after: async (user) =>
              dependencies.provision({ id: user.id, email: user.email }),
          },
        },
        session: {
          create: {
            // Security-key verification applies this same gate before its
            // transaction creates the session; keep additional hooks in sync.
            before: async (session) =>
              (await dependencies.mayStartSession(session.userId))
                ? undefined
                : false,
          },
        },
      },
    });
  // Better Auth also enforces disableSignUp on direct API calls. Keep the
  // enabled instance private for bootstrap and the guarded admin procedure.
  const internal = build(false);
  const publicIdentity = build(true);
  return {
    ...internal,
    claimSignUpWithId: (
      userId: string,
      body: { name: string; email: string; password: string },
    ) => claimId.run(userId, () => internal.api.signUpEmail({ body })),
    handler: Object.assign(publicIdentity.handler, {
      adminSignUp: (body: { name: string; email: string; password: string }) =>
        internal.api.signUpEmail({ body, asResponse: true }),
    }),
  };
};
