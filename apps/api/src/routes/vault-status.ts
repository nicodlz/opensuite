import type { ReadableStreamReadResult } from "node:stream/web";

/** Read only the two public health endpoints. Never forward browser requests. */
export function createVaultStatus(
  origin: string | undefined,
  options: {
    timeoutMs?: number;
    cacheMs?: number;
    fetcher?: typeof fetch;
  } = {},
) {
  const timeoutMs = options.timeoutMs ?? 2000;
  const cacheMs = options.cacheMs ?? 30_000;
  const fetcher = options.fetcher ?? fetch;
  type Status = {
    enabled: boolean;
    reachable: boolean;
    version: string | null;
    checkedAt: string | null;
  };
  let cached: { value: Status; expires: number } | undefined;
  let pending: Promise<Status> | undefined;
  async function check(): Promise<Status> {
    if (origin === undefined)
      return {
        enabled: false,
        reachable: false,
        version: null,
        checkedAt: null,
      };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let reachable = false;
    let version: string | null = null;
    try {
      const init: RequestInit = {
        signal: controller.signal,
        redirect: "error",
        credentials: "omit",
        headers: { accept: "application/json" },
      };
      const [aliveResult, configResult] = await Promise.allSettled([
        fetcher(new URL("/alive", origin), init),
        fetcher(new URL("/api/config", origin), init),
      ]);
      const alive =
        aliveResult.status === "fulfilled" ? aliveResult.value : null;
      const config =
        configResult.status === "fulfilled" ? configResult.value : null;
      reachable = alive?.ok ?? false;
      // Bound the untrusted public response, including chunked bodies.
      if (config?.ok && config.body) {
        const reader = config.body.getReader();
        const chunks: Uint8Array[] = [];
        let size = 0;
        // Stream reads must be sequential to enforce the size limit.
        // oxlint-disable-next-line typescript/no-unnecessary-condition
        while (true) {
          const part: ReadableStreamReadResult<Uint8Array> =
            // oxlint-disable-next-line eslint/no-await-in-loop
            await reader.read();
          if (part.done) break;
          size += part.value.length;
          if (size > 16_384) {
            // oxlint-disable-next-line eslint/no-await-in-loop
            await reader.cancel();
            break;
          }
          chunks.push(part.value);
        }
        if (size <= 16_384) {
          const bytes = new Uint8Array(size);
          let offset = 0;
          for (const chunk of chunks) {
            bytes.set(chunk, offset);
            offset += chunk.length;
          }
          const data: unknown = JSON.parse(new TextDecoder().decode(bytes));
          if (
            typeof data === "object" &&
            data !== null &&
            "version" in data &&
            typeof data.version === "string" &&
            /^[\x20-\x7e]{1,100}$/.test(data.version)
          )
            version = data.version;
        }
      }
      if (config && !config.ok) await config.body?.cancel();
      await alive?.body?.cancel();
    } catch {
      // An optional service being down is a normal status, not a readiness failure.
    } finally {
      clearTimeout(timer);
    }
    return {
      enabled: true,
      reachable,
      version,
      checkedAt: new Date().toISOString(),
    };
  }
  return async (): Promise<Status> => {
    if (cached && cached.expires > Date.now()) return cached.value;
    pending ??= check()
      .then((value) => {
        cached = { value, expires: Date.now() + cacheMs };
        return value;
      })
      .finally(() => {
        pending = undefined;
      });
    return pending;
  };
}
