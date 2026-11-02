import { err, ok } from "neverthrow";
import {
  SessionSchema,
  Transport,
  type JmapResult,
  type Session,
  type TransportOptions,
} from "./protocol.ts";

export class ClientBase {
  protected readonly transport: Transport;
  readonly #origin: string;
  readonly #rewriteOrigin: string | undefined;
  constructor(origin: string, options: TransportOptions) {
    this.#origin = new URL(origin).origin;
    this.transport = new Transport(origin, options);
    this.#rewriteOrigin =
      options.rewriteSessionUrlsToOrigin === undefined
        ? undefined
        : new URL(options.rewriteSessionUrlsToOrigin).origin;
    if (
      this.#rewriteOrigin !== undefined &&
      ("window" in globalThis || !("process" in globalThis))
    )
      throw new Error("Session URL rewrite is server-side only");
    if (
      this.#rewriteOrigin !== undefined &&
      this.#rewriteOrigin !== this.#origin
    )
      throw new Error("Session rewrite origin must match the client origin");
  }
  async discover(): Promise<JmapResult<Session>> {
    const result = await this.transport.json(
      `${this.#origin}/.well-known/jmap`,
      SessionSchema,
    );
    if (result.isErr() || this.#rewriteOrigin === undefined) return result;
    try {
      const rewrite = (value: string) => {
        const url = new URL(value, this.#origin);
        if (
          !["http:", "https:"].includes(url.protocol) ||
          url.username ||
          url.password
        )
          throw new Error("Invalid advertised endpoint");
        return `${this.#origin}${url.pathname}${url.search}`
          .replaceAll("%7B", "{")
          .replaceAll("%7D", "}");
      };
      return ok({
        ...result.value,
        apiUrl: rewrite(result.value.apiUrl),
        ...(result.value.eventSourceUrl === undefined
          ? {}
          : { eventSourceUrl: rewrite(result.value.eventSourceUrl) }),
        uploadUrl: rewrite(result.value.uploadUrl),
        downloadUrl: rewrite(result.value.downloadUrl),
      });
    } catch {
      return err({
        kind: "invalidResponse",
        message: "Invalid advertised endpoint",
      });
    }
  }
}
