// Server-only entry point. Never import this module into browser bundles.
import { Buffer } from "node:buffer";
import { err, ok, type Result } from "neverthrow";
import { z } from "zod";
import {
  JmapCapability,
  SetErrorSchema,
  Transport,
  setFailure,
  type JmapError,
  type TransportOptions,
} from "./protocol.ts";

const DomainSchema = z.object({ id: z.string(), name: z.string() });
const AliasSchema = z.object({
  name: z.string(),
  domainId: z.string(),
  enable: z.boolean(),
});
const AccountSchema = z.object({
  id: z.string(),
  name: z.string(),
  domainId: z.string(),
  "@type": z.string(),
  aliases: z.record(z.string(), AliasSchema),
});
const GetSchema = <T>(item: z.ZodType<T>) =>
  z.object({
    accountId: z.string(),
    list: z.array(item),
    notFound: z.array(z.string()),
  });
const QuerySchema = z.object({
  accountId: z.string(),
  ids: z.array(z.string()),
  position: z.number(),
  queryState: z.string(),
});
const SetSchema = z.object({
  accountId: z.string(),
  created: z.record(z.string(), z.object({ id: z.string() })).optional(),
  updated: z.record(z.string(), z.unknown()).optional(),
  notCreated: z.record(z.string(), SetErrorSchema).nullable().optional(),
  notUpdated: z.record(z.string(), SetErrorSchema).nullable().optional(),
});
const AppPasswordSetSchema = z.object({
  accountId: z.string(),
  created: z
    .record(z.string(), z.object({ id: z.string(), secret: z.string().min(1) }))
    .optional(),
  notCreated: z.record(z.string(), SetErrorSchema).nullable().optional(),
});
const AppPasswordSchema = z.object({ id: z.string(), description: z.string() });
const DestroySchema = z.object({
  accountId: z.string(),
  destroyed: z.array(z.string()).optional(),
  notDestroyed: z.record(z.string(), SetErrorSchema).nullable().optional(),
});
type Domain = z.infer<typeof DomainSchema>;
type Account = z.infer<typeof AccountSchema>;
type Alias = z.infer<typeof AliasSchema>;
type AdminResult<T> = Result<T, JmapError>;
const using = [JmapCapability.core, JmapCapability.management];

export class StalwartAdmin {
  readonly #transport: Transport;
  readonly #api: string;
  constructor(
    origin: string,
    credentials: { username: string; password: string },
    options: Pick<TransportOptions, "fetch"> = {},
  ) {
    this.#api = new URL("/jmap/", origin).href;
    this.#transport = new Transport(origin, {
      authorization: `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString("base64")}`,
      ...options,
    });
  }
  async #list<T>(
    object: string,
    schema: z.ZodType<T>,
  ): Promise<AdminResult<T[]>> {
    const page = async (
      position: number,
      queryState: string | undefined,
      items: T[],
    ): Promise<AdminResult<T[]>> => {
      const query = await this.#transport.call(
        this.#api,
        `x:${object}/query`,
        { position, limit: 100 },
        using,
        QuerySchema,
      );
      if (query.isErr()) return err(query.error);
      if (
        query.value.position !== position ||
        (queryState !== undefined && queryState !== query.value.queryState)
      )
        return err({
          kind: "invalidResponse",
          message: `${object} query changed while paging`,
        });
      const ids = query.value.ids;
      if (ids.length === 0) return ok(items);
      const found = await this.#transport.call(
        this.#api,
        `x:${object}/get`,
        { ids },
        using,
        GetSchema(schema),
      );
      if (found.isErr()) return err(found.error);
      if (
        found.value.notFound.length > 0 ||
        found.value.list.length !== ids.length
      )
        return err({
          kind: "invalidResponse",
          message: `${object} query results changed`,
        });
      const all = [...items, ...found.value.list];
      return ids.length < 100
        ? ok(all)
        : page(position + ids.length, query.value.queryState, all);
    };
    return page(0, undefined, []);
  }

  async #create(object: string, value: object): Promise<AdminResult<string>> {
    const method = `x:${object}/set`;
    const result = await this.#transport.call(
      this.#api,
      method,
      { create: { item: value } },
      using,
      SetSchema,
    );
    if (result.isErr()) return err(result.error);
    const failure = setFailure(method, result.value.notCreated);
    if (failure !== undefined) return err(failure);
    const id = result.value.created?.["item"]?.id;
    return id === undefined
      ? err({ kind: "invalidResponse", message: `Missing ${method} result` })
      : ok(id);
  }
  async createDomain(name: string): Promise<AdminResult<Domain>> {
    const domains = await this.#list("Domain", DomainSchema);
    if (domains.isErr()) return err(domains.error);
    const existing = domains.value.find(
      (domain) => domain.name.toLowerCase() === name.toLowerCase(),
    );
    if (existing !== undefined) return ok(existing);
    const created = await this.#create("Domain", { name });
    return created.isErr()
      ? err(created.error)
      : ok({ id: created.value, name });
  }
  async createAccount(
    name: string,
    domainId: string,
    password: string,
  ): Promise<AdminResult<Account>> {
    const accounts = await this.#list("Account", AccountSchema);
    if (accounts.isErr()) return err(accounts.error);
    const existing = accounts.value.find(
      (account) =>
        account.name.toLowerCase() === name.toLowerCase() &&
        account.domainId === domainId,
    );
    if (existing !== undefined)
      return existing["@type"] === "User"
        ? ok(existing)
        : err({
            kind: "invalidResponse",
            message: "Existing account is not a user",
          });
    const created = await this.#create("Account", {
      "@type": "User",
      name,
      domainId,
      credentials: { "0": { "@type": "Password", secret: password } },
    });
    if (created.isErr()) return err(created.error);
    const result = await this.#transport.call(
      this.#api,
      "x:Account/get",
      { ids: [created.value] },
      using,
      GetSchema(AccountSchema),
    );
    if (result.isErr()) return err(result.error);
    const account = result.value.list[0];
    return account === undefined || result.value.notFound.length !== 0
      ? err({ kind: "invalidResponse", message: "Created account not found" })
      : ok(account);
  }
  async createAlias(
    accountId: string,
    name: string,
    domainId: string,
  ): Promise<AdminResult<Alias>> {
    const accounts = await this.#transport.call(
      this.#api,
      "x:Account/get",
      { ids: [accountId] },
      using,
      GetSchema(AccountSchema),
    );
    if (accounts.isErr()) return err(accounts.error);
    const account = accounts.value.list[0];
    if (account === undefined || accounts.value.notFound.length !== 0)
      return err({ kind: "invalidResponse", message: "Account not found" });
    const existing = Object.values(account.aliases).find(
      (alias) =>
        alias.name.toLowerCase() === name.toLowerCase() &&
        alias.domainId === domainId,
    );
    if (existing !== undefined)
      return existing.enable
        ? ok(existing)
        : err({
            kind: "invalidResponse",
            message: "Existing alias is disabled",
          });
    const index =
      Math.max(
        -1,
        ...Object.keys(account.aliases)
          .map((key) => Number(key))
          .filter(Number.isInteger),
      ) + 1;
    const alias = { name, domainId, enable: true };
    const method = "x:Account/set";
    const updated = await this.#transport.call(
      this.#api,
      method,
      { update: { [accountId]: { [`aliases/${String(index)}`]: alias } } },
      using,
      SetSchema,
    );
    if (updated.isErr()) return err(updated.error);
    const failure = setFailure(method, updated.value.notUpdated);
    if (failure !== undefined) return err(failure);
    return updated.value.updated !== undefined &&
      Object.hasOwn(updated.value.updated, accountId)
      ? ok(alias)
      : err({
          kind: "invalidResponse",
          message: "Missing alias update result",
        });
  }

  /** A returned app password is only available once. Reconcile ambiguous failures. */
  async createAppPassword(
    accountId: string,
  ): Promise<AdminResult<{ id: string; secret: string }>> {
    const method = "x:AppPassword/set";
    const result = await this.#transport.call(
      this.#api,
      method,
      {
        accountId,
        create: {
          item: {
            description: "OpenSuite application",
            permissions: { "@type": "Inherit" },
            allowedIps: {},
          },
        },
      },
      using,
      AppPasswordSetSchema,
    );
    if (result.isErr()) return err(result.error);
    const failure = setFailure(method, result.value.notCreated);
    if (failure !== undefined) return err(failure);
    const credential = result.value.created?.["item"];
    return credential === undefined
      ? err({ kind: "invalidResponse", message: "Missing app password result" })
      : ok(credential);
  }

  /** Suspend accounts created with the default inherited permissions. */
  async suspendAccount(accountId: string): Promise<AdminResult<void>> {
    const method = "x:Account/set";
    const result = await this.#transport.call(
      this.#api,
      method,
      {
        update: {
          [accountId]: {
            permissions: {
              "@type": "Merge",
              enabledPermissions: {},
              disabledPermissions: {
                authenticate: true,
                emailReceive: true,
                emailSend: true,
              },
            },
          },
        },
      },
      using,
      SetSchema,
    );
    if (result.isErr()) return err(result.error);
    const failure = setFailure(method, result.value.notUpdated);
    if (failure !== undefined) return err(failure);
    return result.value.updated !== undefined &&
      Object.hasOwn(result.value.updated, accountId)
      ? ok(undefined)
      : err({
          kind: "invalidResponse",
          message: "Missing account suspension result",
        });
  }

  /** Revoke all credentials created by this application, including lost responses. */
  async revokeApplicationPasswords(
    accountId: string,
  ): Promise<AdminResult<void>> {
    const query = await this.#transport.call(
      this.#api,
      "x:AppPassword/query",
      { accountId, limit: 100 },
      using,
      QuerySchema,
    );
    if (query.isErr()) return err(query.error);
    if (query.value.position !== 0 || query.value.ids.length >= 100)
      return err({
        kind: "invalidResponse",
        message: "App password list requires reconciliation",
      });
    if (query.value.ids.length === 0) return ok(undefined);
    const found = await this.#transport.call(
      this.#api,
      "x:AppPassword/get",
      { accountId, ids: query.value.ids },
      using,
      GetSchema(AppPasswordSchema),
    );
    if (found.isErr()) return err(found.error);
    if (
      found.value.notFound.length > 0 ||
      found.value.list.length !== query.value.ids.length
    )
      return err({
        kind: "invalidResponse",
        message: "App password list changed",
      });
    const ids = found.value.list
      .filter((item) => item.description === "OpenSuite application")
      .map((item) => item.id);
    if (ids.length === 0) return ok(undefined);
    const method = "x:AppPassword/set";
    const destroyed = await this.#transport.call(
      this.#api,
      method,
      { accountId, destroy: ids },
      using,
      DestroySchema,
    );
    if (destroyed.isErr()) return err(destroyed.error);
    const failure = setFailure(method, destroyed.value.notDestroyed);
    if (failure !== undefined) return err(failure);
    return ids.every((id) => destroyed.value.destroyed?.includes(id))
      ? ok(undefined)
      : err({
          kind: "invalidResponse",
          message: "Missing app password revocation result",
        });
  }

  /** Restore the inherited permissions of accounts owned by this provisioner. */
  async resumeAccount(accountId: string): Promise<AdminResult<void>> {
    const method = "x:Account/set";
    const result = await this.#transport.call(
      this.#api,
      method,
      { update: { [accountId]: { permissions: { "@type": "Inherit" } } } },
      using,
      SetSchema,
    );
    if (result.isErr()) return err(result.error);
    const failure = setFailure(method, result.value.notUpdated);
    if (failure !== undefined) return err(failure);
    return result.value.updated !== undefined &&
      Object.hasOwn(result.value.updated, accountId)
      ? ok(undefined)
      : err({
          kind: "invalidResponse",
          message: "Missing account restoration result",
        });
  }
}
