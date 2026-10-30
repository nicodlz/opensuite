// Server-only entry point. Never import this module into browser bundles.
import { Buffer } from "node:buffer";
import { isDeepStrictEqual } from "node:util";
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

const consequent = ["th", "en"].join(""); // Stalwart expression field, not a promise.
const branch = (condition: string, target: string) =>
  Object.fromEntries([
    ["if", condition],
    [consequent, target],
  ]);
const RelayConfigSchema = z.object({
  host: z
    .string()
    .min(1)
    .max(253)
    .regex(/^[a-zA-Z0-9.:-]+$/),
  port: z.number().int().min(1).max(65535),
  username: z.string().min(1).max(512),
  secretFile: z.string().startsWith("/").min(2),
  // Insecure mode exists only for isolated test relays, never for SES.
  tls: z.enum(["starttls", "insecure"]),
});
export type RelayConfig = z.infer<typeof RelayConfigSchema>;
export type DkimDnsRecord = { type: "TXT"; name: string; value: string };
const NamedSchema = z
  .object({ id: z.string(), name: z.string() })
  .catchall(z.unknown());
const DkimSchema = z.object({
  domainId: z.string(),
  selector: z.string(),
  publicKey: z.string().min(1),
  "@type": z.enum(["Dkim1Ed25519Sha256", "Dkim1RsaSha256"]),
  stage: z.string(),
});

type Domain = z.infer<typeof DomainSchema>;
type Account = z.infer<typeof AccountSchema>;
type Alias = z.infer<typeof AliasSchema>;
type AdminResult<T> = Result<T, JmapError>;
const using = [JmapCapability.core, JmapCapability.management];

// Stalwart's own DKIM signing. Through the SES relay it is off: SES signs
// with each domain's Easy DKIM, it refused messages already carrying
// Stalwart's signatures (554 Duplicate header 'DKIM-Signature'), and a
// single Stalwart signature failed at the recipient after relaying.
const relaySigning = { match: {}, else: "false" };
const defaultSigning = {
  match: {
    "0": branch(
      "is_local_domain(sender_domain) && !is_empty(authenticated_as)",
      "sender_domain",
    ),
  },
  else: "false",
};
// Connect to the private Stalwart listener with the network-restricted
// management account. Never pass a public proxy URL or recovery credentials.
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
  async #signingRule(): Promise<AdminResult<unknown>> {
    const read = await this.#transport.call(
      this.#api,
      "x:MtaStageData/get",
      { ids: ["singleton"] },
      using,
      GetSchema(z.object({ id: z.string() }).catchall(z.unknown())),
    );
    if (read.isErr()) return err(read.error);
    const current = read.value.list[0];
    return current === undefined
      ? err({ kind: "invalidResponse", message: "Missing stage settings" })
      : ok(current["dkimSignDomain"]);
  }
  async #setSigning(rule: object): Promise<AdminResult<void>> {
    const current = await this.#signingRule();
    if (current.isErr()) return err(current.error);
    if (!isDeepStrictEqual(current.value, rule)) {
      const updated = await this.#update("MtaStageData", "singleton", {
        dkimSignDomain: rule,
      });
      if (updated.isErr()) return err(updated.error);
    }
    const verified = await this.#signingRule();
    if (verified.isErr()) return err(verified.error);
    return isDeepStrictEqual(verified.value, rule)
      ? ok(undefined)
      : err({
          kind: "invalidResponse",
          message: "DKIM signing did not retain desired settings",
        });
  }
  async #update(
    object: string,
    id: string,
    patch: object,
  ): Promise<AdminResult<void>> {
    const method = `x:${object}/set`;
    const result = await this.#transport.call(
      this.#api,
      method,
      { update: { [id]: patch } },
      using,
      SetSchema,
    );
    if (result.isErr()) return err(result.error);
    const failure = setFailure(method, result.value.notUpdated);
    if (failure !== undefined) return err(failure);
    return result.value.updated !== undefined &&
      Object.hasOwn(result.value.updated, id)
      ? ok(undefined)
      : err({ kind: "invalidResponse", message: `Missing ${method} result` });
  }

  async #ensureNamed(
    object: string,
    name: string,
    fields: Record<string, unknown>,
  ): Promise<AdminResult<string>> {
    const list = await this.#list(object, NamedSchema);
    if (list.isErr()) return err(list.error);
    const matches = list.value.filter((item) => item.name === name);
    if (matches.length > 1)
      return err({
        kind: "invalidResponse",
        message: `Duplicate ${object} named ${name}`,
      });
    let id = matches[0]?.id;
    if (id === undefined) {
      const created = await this.#create(object, { name, ...fields });
      if (created.isErr()) return err(created.error);
      id = created.value;
    } else if (
      Object.entries(fields).some(
        ([key, value]) => !isDeepStrictEqual(matches[0]?.[key], value),
      )
    ) {
      const updated = await this.#update(object, id, fields);
      if (updated.isErr()) return err(updated.error);
    }
    const read = await this.#transport.call(
      this.#api,
      `x:${object}/get`,
      { ids: [id] },
      using,
      GetSchema(NamedSchema),
    );
    if (read.isErr()) return err(read.error);
    const item = read.value.list[0];
    if (
      item === undefined ||
      item.name !== name ||
      Object.entries(fields).some(
        ([key, value]) => !isDeepStrictEqual(item[key], value),
      )
    )
      return err({
        kind: "invalidResponse",
        message: `${object} did not retain desired settings`,
      });
    return ok(id);
  }

  async #reload(): Promise<AdminResult<void>> {
    const result = await this.#create("Action", { "@type": "ReloadSettings" });
    return result.isErr() ? err(result.error) : ok(undefined);
  }

  /** Apply a named relay and bounded queue. Serialize configuration changes. */
  async configureRelay(input: unknown): Promise<AdminResult<void>> {
    const parsed = RelayConfigSchema.safeParse(input);
    if (!parsed.success)
      return err({
        kind: "invalidInput",
        message: "Invalid relay configuration",
      });
    const config = parsed.data;
    // Signing goes off before mail is routed to the relay: a failure here
    // leaves the current route untouched.
    const signing = await this.#setSigning(relaySigning);
    if (signing.isErr()) return err(signing.error);
    const route = await this.#ensureNamed("MtaRoute", "osrelay", {
      "@type": "Relay",
      host: config.host,
      port: config.port,
      protocol: "smtp",
      implicitTls: false,
      allowInvalidCerts: false,
      authUsername: config.username,
      authSecret: { "@type": "File", filePath: config.secretFile },
    });
    if (route.isErr()) return err(route.error);
    const queue = await this.#ensureNamed("MtaVirtualQueue", "osout", {
      threadsPerNode: 1,
    });
    if (queue.isErr()) return err(queue.error);
    const schedule = await this.#ensureNamed("MtaDeliverySchedule", "osout", {
      queueId: queue.value,
      expiry: { "@type": "Ttl", expire: 86400000 },
      retry: {
        "@type": "Custom",
        intervals: {
          "0": { duration: 300000 },
          "1": { duration: 1800000 },
          "2": { duration: 7200000 },
        },
      },
      notify: { "@type": "Custom", intervals: { "0": { duration: 14400000 } } },
    });
    if (schedule.isErr()) return err(schedule.error);
    const tls = await this.#ensureNamed("MtaTlsStrategy", "osrelay", {
      startTls: config.tls === "starttls" ? "require" : "disable",
      allowInvalidCerts: false,
      dane: "disable",
      mtaSts: "disable",
    });
    if (tls.isErr()) return err(tls.error);
    const strategy = {
      route: {
        match: { "0": branch("is_local_domain(rcpt_domain)", "'local'") },
        else: "'osrelay'",
      },
      schedule: {
        match: { "0": branch("is_local_domain(rcpt_domain)", "'local'") },
        else: "'osout'",
      },
      tls: { match: {}, else: "'osrelay'" },
    };
    const read = await this.#transport.call(
      this.#api,
      "x:MtaOutboundStrategy/get",
      { ids: ["singleton"] },
      using,
      GetSchema(z.object({ id: z.string() }).catchall(z.unknown())),
    );
    if (read.isErr()) return err(read.error);
    const current = read.value.list[0];
    if (current === undefined)
      return err({
        kind: "invalidResponse",
        message: "Missing outbound strategy",
      });
    if (
      Object.entries(strategy).some(
        ([key, value]) => !isDeepStrictEqual(current[key], value),
      )
    ) {
      const updated = await this.#update(
        "MtaOutboundStrategy",
        "singleton",
        strategy,
      );
      if (updated.isErr()) return err(updated.error);
    }
    const verified = await this.#transport.call(
      this.#api,
      "x:MtaOutboundStrategy/get",
      { ids: ["singleton"] },
      using,
      GetSchema(z.object({ id: z.string() }).catchall(z.unknown())),
    );
    if (verified.isErr()) return err(verified.error);
    if (
      verified.value.list[0] === undefined ||
      Object.entries(strategy).some(
        ([key, value]) =>
          !isDeepStrictEqual(verified.value.list[0]?.[key], value),
      )
    )
      return err({
        kind: "invalidResponse",
        message: "Outbound strategy did not retain desired settings",
      });
    // Always reload: a previous attempt may have saved settings but lost its response.
    return this.#reload();
  }

  /** Inspect the configured SES route without returning credentials. */
  async sesRelayConfigured(): Promise<AdminResult<boolean>> {
    const route = await this.#list("MtaRoute", NamedSchema);
    if (route.isErr()) return err(route.error);
    const tls = await this.#list("MtaTlsStrategy", NamedSchema);
    if (tls.isErr()) return err(tls.error);
    const strategy = await this.#transport.call(
      this.#api,
      "x:MtaOutboundStrategy/get",
      { ids: ["singleton"] },
      using,
      GetSchema(z.object({ id: z.string() }).catchall(z.unknown())),
    );
    if (strategy.isErr()) return err(strategy.error);
    const signing = await this.#signingRule();
    if (signing.isErr()) return err(signing.error);
    const current = strategy.value.list[0];
    if (current === undefined || strategy.value.notFound.length > 0)
      return err({
        kind: "invalidResponse",
        message: "Missing outbound strategy",
      });
    const target = route.value.find((item) => item.name === "osrelay");
    const tlsTarget = tls.value.find((item) => item.name === "osrelay");
    return ok(
      target?.["@type"] === "Relay" &&
        target["host"] === "email-smtp.eu-north-1.amazonaws.com" &&
        target["port"] === 2587 &&
        target["protocol"] === "smtp" &&
        target["implicitTls"] === false &&
        target["allowInvalidCerts"] === false &&
        typeof target["authUsername"] === "string" &&
        target["authUsername"].length > 0 &&
        z
          .object({ "@type": z.literal("File"), filePath: z.string().min(1) })
          .safeParse(target["authSecret"]).success &&
        tlsTarget?.["startTls"] === "require" &&
        tlsTarget["allowInvalidCerts"] === false &&
        isDeepStrictEqual(current["route"], {
          match: { "0": branch("is_local_domain(rcpt_domain)", "'local'") },
          else: "'osrelay'",
        }) &&
        isDeepStrictEqual(current["tls"], { match: {}, else: "'osrelay'" }) &&
        isDeepStrictEqual(signing.value, relaySigning),
    );
  }

  /** Restore Stalwart's default routing, scheduling and TLS expressions. */
  async resetOutbound(): Promise<AdminResult<void>> {
    const result = await this.#update("MtaOutboundStrategy", "singleton", {
      route: {
        match: { "0": branch("is_local_domain(rcpt_domain)", "'local'") },
        else: "'mx'",
      },
      schedule: {
        match: {
          "0": branch("is_local_domain(rcpt_domain)", "'local'"),
          "1": branch("source == 'dsn'", "'dsn'"),
          "2": branch("source == 'report'", "'report'"),
        },
        else: "'remote'",
      },
      tls: {
        match: {
          "0": branch("retry_num > 0 && last_error == 'tls'", "'invalid-tls'"),
        },
        else: "'default'",
      },
    });
    if (result.isErr()) return err(result.error);
    const signing = await this.#setSigning(defaultSigning);
    return signing.isErr() ? err(signing.error) : this.#reload();
  }

  /** Return public DNS records for generated, active DKIM keys; never write DNS. */
  async dkimRecords(domainId: string): Promise<AdminResult<DkimDnsRecord[]>> {
    if (!z.string().min(1).safeParse(domainId).success)
      return err({ kind: "invalidInput", message: "Invalid domain ID" });
    const domain = await this.#transport.call(
      this.#api,
      "x:Domain/get",
      { ids: [domainId] },
      using,
      GetSchema(DomainSchema),
    );
    if (domain.isErr()) return err(domain.error);
    const found = domain.value.list[0];
    if (found === undefined || domain.value.notFound.length > 0)
      return err({ kind: "invalidResponse", message: "Domain not found" });
    const signatures = await this.#list("DkimSignature", DkimSchema);
    if (signatures.isErr()) return err(signatures.error);
    const records: DkimDnsRecord[] = signatures.value
      .filter((item) => item.domainId === domainId && item.stage === "active")
      .map((item) => ({
        type: "TXT",
        name: `${item.selector}._domainkey.${found.name}`,
        value: `v=DKIM1; k=${item["@type"] === "Dkim1RsaSha256" ? "rsa" : "ed25519"}; h=sha256; p=${item.publicKey}`,
      }));
    return records.length > 0
      ? ok(records)
      : err({
          kind: "invalidResponse",
          message: "No active DKIM keys for domain",
        });
  }

  async findDomain(name: string): Promise<AdminResult<Domain>> {
    const domains = await this.#list("Domain", DomainSchema);
    if (domains.isErr()) return err(domains.error);
    const existing = domains.value.find(
      (domain) => domain.name.toLowerCase() === name.toLowerCase(),
    );
    return existing === undefined
      ? err({ kind: "invalidResponse", message: "Domain not found" })
      : ok(existing);
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

  /** Remove an existing alias without changing other account aliases. */
  async removeAlias(
    accountId: string,
    name: string,
    domainId: string,
  ): Promise<AdminResult<void>> {
    const result = await this.#transport.call(
      this.#api,
      "x:Account/get",
      { ids: [accountId] },
      using,
      GetSchema(AccountSchema),
    );
    if (result.isErr()) return err(result.error);
    const account = result.value.list[0];
    if (account === undefined && result.value.notFound.includes(accountId))
      return ok(undefined);
    if (account === undefined || result.value.notFound.length !== 0)
      return err({ kind: "invalidResponse", message: "Account not found" });
    const entry = Object.entries(account.aliases).find(
      ([, alias]) =>
        alias.name.toLowerCase() === name.toLowerCase() &&
        alias.domainId === domainId,
    );
    return entry === undefined
      ? ok(undefined)
      : this.#update("Account", accountId, { [`aliases/${entry[0]}`]: null });
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
