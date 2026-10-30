import type {
  ReadableStreamDefaultReader,
  ReadableStreamReadResult,
} from "node:stream/web";

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
      if (config?.ok && config.body) version = await readVersion(config.body);
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

// Read sequentially and stop as soon as the untrusted body exceeds the cap.
async function readVersion(
  body: NonNullable<Response["body"]>,
): Promise<string | null> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  const size = await readChunks(reader, chunks, 0);
  if (size === null) return null;
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  const data: unknown = JSON.parse(new TextDecoder().decode(bytes));
  return typeof data === "object" &&
    data !== null &&
    "version" in data &&
    typeof data.version === "string" &&
    /^[\x20-\x7e]{1,100}$/.test(data.version)
    ? data.version
    : null;
}

function readChunks(
  reader: ReadableStreamDefaultReader,
  chunks: Uint8Array[],
  size: number,
): Promise<number | null> {
  return reader.read().then((part: ReadableStreamReadResult<Uint8Array>) => {
    if (part.done) return size;
    const nextSize = size + part.value.length;
    if (nextSize > 16_384) return reader.cancel().then(() => null);
    chunks.push(part.value);
    return readChunks(reader, chunks, nextSize);
  });
}
