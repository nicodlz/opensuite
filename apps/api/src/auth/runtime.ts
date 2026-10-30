import { createHash, randomBytes } from "node:crypto";
import type {
  AccountFailure,
  AccountService,
} from "@opensuite/core/services/accounts";
import {
  createProvisioningService,
  type ProvisionFailure,
  type ProvisioningPort,
} from "@opensuite/core/services/provisioning";
import {
  createAccountStore,
  createAddressStore,
  validMailboxLocalPart,
  createProvisioningStore,
  type PrismaClient,
} from "@opensuite/db";
import { StalwartAdmin } from "@opensuite/jmap/admin";
import { err, ok } from "neverthrow";
import { createIdentity } from "./identity.ts";

interface RuntimeConfig {
  readonly publicOrigin: string;
  readonly productOrigins?: Readonly<Record<string, string>>;
  readonly mailDomain: string;
  /** Every configured account domain, `mailDomain` included. */
  readonly mailDomains?: readonly string[];
  readonly stalwartOrigin: string;
  readonly secret: string;
  readonly mailboxKey: string;
  readonly adminPassword: string;
  readonly managementClientIp?: string;
}
const failure = (): ProvisionFailure => ({
  kind: "unavailable",
  message: "mailbox provisioning failed",
});

export const createAuthRuntime = (
  db: PrismaClient,
  config: RuntimeConfig,
  fetcher: typeof fetch = fetch,
) => {
  const productOrigins = config.productOrigins ?? {
    mail: config.publicOrigin,
  };
  const trustedOrigins = [
    ...new Set([config.publicOrigin, ...Object.values(productOrigins)]),
  ];
  const accounts = createAccountStore(db);
  const primaryReservations = createAddressStore(
    db,
    config.mailDomains ?? [config.mailDomain],
  );
  const storeResult = createProvisioningStore(db, config.mailboxKey);
  if (storeResult.isErr()) throw new Error("invalid mailbox encryption key");
  const store = storeResult.value;
  const admin = new StalwartAdmin(
    config.stalwartOrigin,
    {
      username: "management@opensuite.internal",
      password: config.adminPassword,
    },
    {
      fetch: (input, init) =>
        fetcher(input, {
          ...init,
          headers: {
            ...Object.fromEntries(new Headers(init?.headers)),
            ...(config.managementClientIp === undefined
              ? {}
              : { "X-Forwarded-For": config.managementClientIp }),
          },
          signal: AbortSignal.timeout(10_000),
        }),
    },
  );
  const configured = new Set(config.mailDomains ?? [config.mailDomain]);
  /** A configured domain or one an administrator manages in the console. */
  const isMailDomain = async (domain: string | undefined) => {
    if (domain === undefined) return false;
    const managed = await db.domain.findUnique({
      where: { name: domain },
      select: { removalPending: true },
    });
    // A removal in progress wins over the configuration.
    if (managed !== null) return !managed.removalPending;
    return configured.has(domain);
  };
  const audit = async (event: { userId: string | null; action: string }) => {
    const result = await accounts.audit(event);
    if (result.isErr()) throw new Error("audit unavailable");
  };
  const port: ProvisioningPort = {
    ensureAccount: async (userId) => {
      const user = await store.user(userId);
      if (user.isErr()) return err(failure());
      const [local, domain, extra] = user.value.email.toLowerCase().split("@");
      if (
        local === undefined ||
        !validMailboxLocalPart(local) ||
        domain === undefined ||
        extra !== undefined ||
        !(await isMailDomain(domain))
      )
        return err(failure());
      // The address must not already be another user's address or alias.
      const taken = await db.$queryRaw<
        { id: string }[]
      >`SELECT a."id" FROM "Address" a JOIN "Domain" d ON d."id" = a."domainId" WHERE lower(a."localPart") = ${local} AND d."name" = ${domain} AND a."userId" <> ${userId} LIMIT 1`;
      if (taken.length > 0) return err(failure());
      const domainResult = await admin.createDomain(domain);
      if (domainResult.isErr()) return err(failure());
      const name = `os-${createHash("sha256").update(userId).digest("hex").slice(0, 32)}`;
      const account = await admin.createAccount(
        name,
        domainResult.value.id,
        randomBytes(32).toString("base64url"),
      );
      if (account.isErr()) return err(failure());
      const alias = await admin.createAlias(
        account.value.id,
        local,
        domainResult.value.id,
      );
      if (alias.isErr()) return err(failure());
      return ok({
        accountId: account.value.id,
        address: user.value.email.toLowerCase(),
      });
    },
    suspend: async (id) => (await admin.suspendAccount(id)).mapErr(failure),
    resume: async (id) => (await admin.resumeAccount(id)).mapErr(failure),
    revokeApplicationPasswords: async (id) => {
      const result = await admin.revokeApplicationPasswords(id);
      const owner = await store.userForAccount(id);
      if (owner.isErr()) throw new Error("account lookup failed");
      await audit({
        userId: owner.value,
        action: `app_password.revoke.${result.isOk() ? "success" : "failure"}`,
      });
      return result.mapErr(failure);
    },
    issue: async (id) => {
      const result = await admin.createAppPassword(id);
      const owner = await store.userForAccount(id);
      if (owner.isErr()) throw new Error("account lookup failed");
      await audit({
        userId: owner.value,
        action: `app_password.issue.${result.isOk() ? "success" : "failure"}`,
      });
      return result.mapErr(failure);
    },
  };
  const provisioning = createProvisioningService(
    {
      prepare: async (id) => store.prepare(id),
      beginIssuance: async (id, account) => store.beginIssuance(id, account),
      activate: async (id, account, credential) =>
        store.activate(id, account, credential),
      markDisabled: async (id, actor) => store.markDisabled(id, actor),
      mailboxAccountId: async (id) => store.mailboxAccountId(id),
      finishDisabled: async (id) => store.finishDisabled(id),
    },
    port,
  );
  const identity = createIdentity({
    database: db,
    publicOrigin: config.publicOrigin,
    trustedOrigins: trustedOrigins,
    secret: config.secret,
    provision: async (user) => {
      const result = await provisioning.ensure(user.id);
      if (result.isErr()) throw new Error("mailbox provisioning failed");
    },
    mayStartSession: async (userId) => {
      const result = await store.sessionAllowed(userId);
      return result.isOk() && result.value;
    },
  });
  const reconcile = async () => {
    const pending = await store.pending();
    if (pending.isErr()) throw new Error("reconciliation lookup failed");
    return pending.value.reduce(async (previous, user) => {
      const failures = await previous;
      const result = user.disabled
        ? await provisioning.suspend(user.id)
        : await provisioning.ensure(user.id);
      return failures + (result.isErr() ? 1 : 0);
    }, Promise.resolve(0));
  };
  return {
    reconcile,
    mailAdmin: admin,
    claimSignUp: async (input: {
      email: string;
      password: string;
      name: string;
      userId: string;
    }) => {
      if (input.email.toLowerCase().split("@")[1] !== config.mailDomain)
        throw new Error("address unavailable");
      try {
        if (
          await db.user.findUnique({
            where: { id: input.userId },
            select: { id: true },
          })
        )
          throw new Error("address unavailable");
        const created = await identity.claimSignUpWithId(input.userId, {
          email: input.email,
          password: input.password,
          name: input.name,
        });
        if (created.user.id !== input.userId)
          throw new Error("claim identity mismatch");
        await audit({ userId: created.user.id, action: "sign_up.success" });
        return created.user.id;
      } catch {
        await audit({ userId: null, action: "sign_up.failure" });
        throw new Error("address unavailable");
      }
    },
    bootstrap: async (email: string, password: string, name: string) => {
      if (!(await isMailDomain(email.toLowerCase().split("@")[1])))
        throw new Error("email domain is not configured");
      const existing = await accounts.userIdForEmail(email);
      if (existing.isErr()) throw new Error("account lookup failed");
      if (existing.value === null) {
        try {
          const created = await primaryReservations.withPrimaryReservation(
            email,
            () =>
              identity.api.signUpEmail({
                body: { email: email.toLowerCase(), password, name },
              }),
          );
          if (!created) throw new Error("address unavailable");
          await audit({ userId: created.user.id, action: "sign_up.success" });
        } catch (error) {
          await audit({ userId: null, action: "sign_up.failure" });
          throw error;
        }
      } else {
        const result = await provisioning.ensure(existing.value);
        if (result.isErr()) throw new Error("mailbox provisioning failed");
      }
      const promoted = await accounts.bootstrap(email);
      if (promoted.isErr()) throw new Error("administrator promotion failed");
    },
    identity: {
      handler: identity.handler,
      withPrimaryReservation: primaryReservations.withPrimaryReservation,
      publicOrigin: config.publicOrigin,
      trustedOrigins,
      productOrigins,
      mailDomain: config.mailDomain,
      isMailDomain,
      actor: async (headers: Headers) => {
        const session = await identity.api.getSession({
          headers,
          query: { disableCookieCache: true },
        });
        if (session === null) return null;
        const allowed = await store.sessionAllowed(session.user.id);
        if (allowed.isErr() || !allowed.value) return null;
        const result = await accounts.actor(session.user.id);
        if (result.isErr()) throw new Error("account lookup failed");
        return result.value === null
          ? null
          : { ...result.value, sessionId: session.session.id };
      },
      userIdForEmail: async (email: string) => {
        const result = await accounts.userIdForEmail(email);
        if (result.isErr()) throw new Error("account lookup failed");
        return result.value;
      },
      audit,
    },
    accounts: {
      mailbox: async (actor, id) => accounts.mailbox(actor, id),
      list: async (actor) => accounts.list(actor),
      disable: async (
        actor: { id: string; role: "admin" | "user" },
        userId: string,
      ) => {
        if (actor.role !== "admin")
          return err<never, AccountFailure>({
            kind: "forbidden",
            message: "access denied",
          });
        const result = await provisioning.disable(userId, actor.id);
        return result.mapErr((error): AccountFailure =>
          error.kind === "forbidden"
            ? { kind: "forbidden", message: error.message }
            : { kind: "unavailable", message: error.message },
        );
      },
    } satisfies AccountService,
  };
};
