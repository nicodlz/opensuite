import { err, ok, type Result } from "neverthrow";
import { z } from "zod";

export const JmapCapability = {
  core: "urn:ietf:params:jmap:core",
  mail: "urn:ietf:params:jmap:mail",
  submission: "urn:ietf:params:jmap:submission",
  blob: "urn:ietf:params:jmap:blob",
  management: "urn:stalwart:jmap",
} as const;

const ErrorSchema = z.object({
  type: z.string(),
  description: z.string().optional(),
});
export type JmapError =
  | { kind: "network"; message: string }
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
  constructor(origin: string, options: TransportOptions) {
    this.#origin = new URL(origin).origin;
    this.#authorization = options.authorization;
    this.#fetch = options.fetch ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? 120_000;
  }

  async request(
    url: string,
    init: RequestInit = {},
  ): Promise<JmapResult<Response>> {
    let target: URL;
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
      const signal =
        init.signal === null || init.signal === undefined
          ? timeout
          : AbortSignal.any([init.signal, timeout]);
      headers.set("Authorization", this.#authorization);
      // Discovery may redirect on the same origin; never forward credentials to another origin.
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
        const problem = ErrorSchema.safeParse(data);
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
      return err({
        kind: "network",
        message: cause instanceof Error ? cause.message : String(cause),
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
  ): Promise<JmapResult<T>> {
    const response = await this.json(apiUrl, ResponseSchema, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ using, methodCalls: [[method, args, "0"]] }),
    });
    if (response.isErr()) return err(response.error);
    const calls = response.value.methodResponses;
    const call = calls[0];
    if (calls.length !== 1 || call === undefined || call[2] !== "0")
      return err({
        kind: "invalidResponse",
        message: "Unexpected method response count or call id",
      });
    if (call[0] === "error") {
      const parsed = ErrorSchema.safeParse(call[1]);
      return parsed.success
        ? err({ kind: "method", method, ...parsed.data })
        : err({ kind: "invalidResponse", message: "Invalid method error" });
    }
    if (call[0] !== method)
      return err({
        kind: "invalidResponse",
        message: "Unexpected method response name",
      });
    const parsed = schema.safeParse(call[1]);
    return parsed.success
      ? ok(parsed.data)
      : err({ kind: "invalidResponse", message: parsed.error.message });
  }
}

export const SetErrorSchema = ErrorSchema;
export const setFailure = (
  method: string,
  errors: Record<string, z.infer<typeof SetErrorSchema>> | null | undefined,
): JmapError | undefined => {
  const entry = Object.entries(errors ?? {})[0];
  return entry === undefined
    ? undefined
    : { kind: "set", method, id: entry[0], ...entry[1] };
};
