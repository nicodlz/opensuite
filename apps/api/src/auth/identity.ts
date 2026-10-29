import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { twoFactor } from "better-auth/plugins";

/** Trusted composition supplies an adapter and lifecycle callbacks. */
export interface IdentityDependencies {
  readonly database: object;
  readonly publicOrigin: string;
  readonly secret: string;
  readonly provision: (user: { id: string; email: string }) => Promise<void>;
  readonly mayStartSession: (userId: string) => Promise<boolean>;
}

export const createIdentity = (dependencies: IdentityDependencies) =>
  betterAuth({
    appName: "OpenSuite",
    baseURL: dependencies.publicOrigin,
    basePath: "/api/auth",
    secret: dependencies.secret,
    database: prismaAdapter(dependencies.database, {
      provider: "postgresql",
      transaction: true,
    }),
    trustedOrigins: [dependencies.publicOrigin],
    // Provisioning runs after the user transaction commits. A session is only
    // issued by a later sign-in after the mailbox link has been checked.
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 12,
      autoSignIn: false,
    },
    plugins: [twoFactor()],
    advanced: {
      useSecureCookies: true,
      defaultCookieAttributes: {
        httpOnly: true,
        secure: true,
        sameSite: "lax",
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
          before: async (session) =>
            (await dependencies.mayStartSession(session.userId))
              ? undefined
              : false,
        },
      },
    },
  });
