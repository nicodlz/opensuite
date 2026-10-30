export const timedFetch =
  (headers: Readonly<Record<string, string>> = {}): typeof fetch =>
  (input, init) => {
    const merged = new Headers(init?.headers);
    for (const [name, value] of Object.entries(headers))
      merged.set(name, value);
    const timeout = AbortSignal.timeout(10_000);
    return fetch(input, {
      ...init,
      headers: merged,
      signal: init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout,
    });
  };
