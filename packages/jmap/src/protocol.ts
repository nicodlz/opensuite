import { err, ok, type Result } from "neverthrow";
import { z } from "zod";

export const JmapCapability = {
  core: "urn:ietf:params:jmap:core",
  mail: "urn:ietf:params:jmap:mail",
  submission: "urn:ietf:params:jmap:submission",
  blob: "urn:ietf:params:jmap:blob",
  calendars: "urn:ietf:params:jmap:calendars",
  contacts: "urn:ietf:params:jmap:contacts",
  management: "urn:stalwart:jmap",
} as const;

const JErr = z.object({ type: z.string(), description: z.string().optional() });
export type JmapError =
  | { kind: "invalidInput"; message: string }
  | { kind: "network"; message: string; beforeRequest?: boolean }
  | { kind: "http"; status: number; body: string }
  | {
      kind: "request";
      status: number;
      type: string;
      description?: string | undefined;
    }
  | {
      kind: "method";
      method: string;
      type: string;
      description?: string | undefined;
    }
  | {
      kind: "set";
      method: string;
      id: string;
      type: string;
      description?: string | undefined;
    }
  | { kind: "invalidResponse"; message: string };
export type JmapResult<T> = Result<T, JmapError>;

export interface TransportOptions {
  readonly authorization: string;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
  /** Abort all requests made by this client, including response bodies. */
  readonly signal?: AbortSignal;
  readonly rewriteSessionUrlsToOrigin?: string;
}

export const SessionSchema = z.object({
  capabilities: z.record(z.string(), z.unknown()),
  accounts: z.record(
    z.string(),
    z.object({
      name: z.string(),
      isPersonal: z.boolean(),
      isReadOnly: z.boolean(),
      accountCapabilities: z.record(z.string(), z.unknown()),
    }),
  ),
  primaryAccounts: z.record(z.string(), z.string()),
  username: z.string(),
  apiUrl: z.url(),
  eventSourceUrl: z.url().optional(),
  downloadUrl: z.string(),
  uploadUrl: z.string(),
  state: z.string(),
});
export type Session = z.infer<typeof SessionSchema>;

const ResponseSchema = z.object({
  methodResponses: z.array(z.tuple([z.string(), z.unknown(), z.string()])),
  sessionState: z.string(),
});

export class Transport {
  readonly #authorization: string;
  readonly #fetch: typeof fetch;
  readonly #origin: string;
  readonly #timeoutMs: number;
  readonly #signal: AbortSignal | undefined;
  constructor(origin: string, options: TransportOptions) {
    this.#origin = new URL(origin).origin;
    this.#authorization = options.authorization;
    this.#fetch = options.fetch ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? 120_000;
    this.#signal = options.signal;
  }

  async request(
    url: string,
    init: RequestInit = {},
  ): Promise<JmapResult<Response>> {
    let target: URL;
    let requests = 0;
    try {
      target = new URL(url, this.#origin);
    } catch {
      return err({ kind: "invalidResponse", message: "Invalid endpoint URL" });
    }
    if (target.origin !== this.#origin)
      return err({
        kind: "invalidResponse",
        message: "Endpoint has a different origin",
      });
    try {
      const headers = new Headers(init.headers);
      const timeout = AbortSignal.timeout(this.#timeoutMs);
      const signals = [timeout];
      if (this.#signal !== undefined) signals.push(this.#signal);
      if (init.signal !== null && init.signal !== undefined)
        signals.push(init.signal);
      const signal = signals.length === 1 ? timeout : AbortSignal.any(signals);
      headers.set("Authorization", this.#authorization);
      // Discovery may redirect on the same origin; never forward credentials to another origin.
      requests++;
      let response = await this.#fetch(target, {
        ...init,
        headers,
        signal,
        redirect: "manual",
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        if (location === null)
          return err({
            kind: "invalidResponse",
            message: "Redirect without location",
          });
        const next = new URL(location, target);
        if (next.origin !== this.#origin)
          return err({
            kind: "invalidResponse",
            message: "Redirect has a different origin",
          });
        requests++;
        response = await this.#fetch(next, {
          ...init,
          headers,
          signal,
          redirect: "manual",
        });
      }
      if (!response.ok) {
        const body = await response.text();
        let data: unknown;
        try {
          data = JSON.parse(body);
        } catch {
          data = undefined;
        }
        const problem = JErr.safeParse(data);
        if (problem.success)
          return err({
            kind: "request",
            status: response.status,
            ...problem.data,
          });
        return err({ kind: "http", status: response.status, body });
      }
      return ok(response);
    } catch (cause) {
      const refused = z
        .object({ cause: z.object({ code: z.literal("ECONNREFUSED") }) })
        .safeParse(cause);
      return err({
        kind: "network",
        message: cause instanceof Error ? cause.message : String(cause),
        ...(requests === 1 && refused.success ? { beforeRequest: true } : {}),
      });
    }
  }

  async json<T>(
    url: string,
    schema: z.ZodType<T>,
    init?: RequestInit,
  ): Promise<JmapResult<T>> {
    const response = await this.request(url, init);
    if (response.isErr()) return err(response.error);
    let data: unknown;
    try {
      data = await response.value.json();
    } catch {
      return err({ kind: "invalidResponse", message: "Response is not JSON" });
    }
    const parsed = schema.safeParse(data);
    return parsed.success
      ? ok(parsed.data)
      : err({ kind: "invalidResponse", message: parsed.error.message });
  }

  async call<T>(
    apiUrl: string,
    method: string,
    args: object,
    using: readonly string[],
    schema: z.ZodType<T>,
    followup?: "Email/set",
  ): Promise<JmapResult<T>> {
    const response = await this.json(apiUrl, ResponseSchema, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ using, methodCalls: [[method, args, "0"]] }),
    });
    if (response.isErr()) return err(response.error);
    const calls = response.value.methodResponses;
    const call = calls[0];
    if (
      (calls.length !== 1 && !(followup !== undefined && calls.length === 2)) ||
      call === undefined ||
      call[2] !== "0"
    )
      return err({
        kind: "invalidResponse",
        message: "Unexpected method response count or call id",
      });
    if (call[0] === "error") {
      const parsed = JErr.safeParse(call[1]);
      return parsed.success
        ? err({ kind: "method", method, ...parsed.data })
        : err({ kind: "invalidResponse", message: "Invalid method error" });
    }
    if (call[0] !== method)
      return err({
        kind: "invalidResponse",
        message: "Unexpected method response name",
      });
    if (calls.length === 2) {
      const extra = calls[1];
      if (extra === undefined || extra[0] !== followup || extra[2] !== "0")
        return err({
          kind: "invalidResponse",
          message: "Unexpected follow-up response",
        });
      const update = z
        .object({
          notUpdated: z
            .record(z.string(), SetErrorSchema)
            .nullable()
            .optional(),
        })
        .safeParse(extra[1]);
      if (!update.success)
        return err({
          kind: "invalidResponse",
          message: "Invalid follow-up response",
        });
      const failure = setFailure(followup, update.data.notUpdated);
      if (failure !== undefined) return err(failure);
    }
    const parsed = schema.safeParse(call[1]);
    return parsed.success
      ? ok(parsed.data)
      : err({ kind: "invalidResponse", message: parsed.error.message });
  }
}

export const SetErrorSchema = JErr;
export const setFailure = (
  method: string,
  errors: Record<string, z.infer<typeof SetErrorSchema>> | null | undefined,
): JmapError | undefined => {
  const entry = Object.entries(errors ?? {})[0];
  return entry === undefined
    ? undefined
    : { kind: "set", method, id: entry[0], ...entry[1] };
};

const ContactBookSchema = z.object({
  id: z.string(),
  name: z.string(),
  isDefault: z.boolean(),
  myRights: z.object({
    mayRead: z.boolean(),
    mayWrite: z.boolean(),
    mayDelete: z.boolean(),
  }),
});
const ContactCardSchema = z.looseObject({
  id: z.string(),
  addressBookIds: z.record(z.string(), z.boolean()),
  name: z.looseObject({ full: z.string().optional() }).nullable().optional(),
  emails: z
    .record(z.string(), z.looseObject({ address: z.string() }))
    .nullish(),
});
const ContactSetSchema = z.object({
  accountId: z.string(),
  newState: z.string().optional(),
  created: z.record(z.string(), z.object({ id: z.string() })).nullish(),
  updated: z.record(z.string(), z.unknown()).nullish(),
  destroyed: z.array(z.string()).nullish(),
  notCreated: z.record(z.string(), SetErrorSchema).nullish(),
  notUpdated: z.record(z.string(), SetErrorSchema).nullish(),
  notDestroyed: z.record(z.string(), SetErrorSchema).nullish(),
});
type GetFactory = <T>(item: z.ZodType<T>) => z.ZodType<{
  accountId: string;
  state: string;
  list: T[];
  notFound: string[];
}>;
type ContactQuery = {
  accountId: string;
  queryState: string;
  canCalculateChanges: boolean;
  position: number;
  ids: string[];
  total?: number | undefined;
};
const contactCapabilities = [JmapCapability.core, JmapCapability.contacts];

/** User-scoped contacts and sent-recipient operations on the JMAP transport. */
export class ContactsApi {
  readonly #transport: Transport;
  readonly #get: GetFactory;
  readonly #query: z.ZodType<ContactQuery>;
  constructor(
    transport: Transport,
    get: GetFactory,
    query: z.ZodType<ContactQuery>,
  ) {
    this.#transport = transport;
    this.#get = get;
    this.#query = query;
  }
  addressBooks(session: Session, accountId: string) {
    return this.#transport.call(
      session.apiUrl,
      "AddressBook/get",
      { accountId },
      contactCapabilities,
      this.#get(ContactBookSchema),
    );
  }
  queryContacts(
    session: Session,
    accountId: string,
    options: {
      filter?: object;
      position?: number;
      limit?: number;
      calculateTotal?: boolean;
    },
  ) {
    return this.#transport.call(
      session.apiUrl,
      "ContactCard/query",
      { accountId, ...options },
      contactCapabilities,
      this.#query,
    );
  }
  contactCards(session: Session, accountId: string, ids: readonly string[]) {
    return this.#transport.call(
      session.apiUrl,
      "ContactCard/get",
      { accountId, ids },
      contactCapabilities,
      this.#get(ContactCardSchema),
    );
  }
  async setContact(
    session: Session,
    accountId: string,
    change: {
      create?: Record<string, object>;
      update?: Record<string, object>;
      destroy?: string[];
      ifInState?: string;
    },
  ) {
    const method = "ContactCard/set";
    const result = await this.#transport.call(
      session.apiUrl,
      method,
      { accountId, ...change },
      contactCapabilities,
      ContactSetSchema,
    );
    if (result.isErr()) return result;
    const failure =
      setFailure(method, result.value.notCreated) ??
      setFailure(method, result.value.notUpdated) ??
      setFailure(method, result.value.notDestroyed);
    return failure === undefined ? result : err(failure);
  }
  recentRecipients(
    session: Session,
    accountId: string,
    ids: readonly string[],
  ) {
    const address = z.object({
      name: z.string().nullable(),
      email: z.string(),
    });
    const message = z.object({
      id: z.string(),
      to: z.array(address).nullable(),
      cc: z.array(address).nullable(),
      bcc: z.array(address).nullable(),
    });
    return this.#transport.call(
      session.apiUrl,
      "Email/get",
      { accountId, ids, properties: ["id", "to", "cc", "bcc"] },
      [JmapCapability.core, JmapCapability.mail],
      this.#get(message),
    );
  }
}
