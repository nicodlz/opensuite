import { isIP } from "node:net";

export function networkBucket(ip: string): string {
  const normalized = ip.toLowerCase().split("%")[0] ?? "";
  if (normalized.startsWith("::ffff:") && isIP(normalized.slice(7)) === 4)
    return normalized.slice(7);
  if (isIP(normalized) !== 6) return normalized;
  const [left = "", right = ""] = normalized.split("::");
  const a = left ? left.split(":") : [];
  const b = right ? right.split(":") : [];
  const parts = normalized.includes("::")
    ? [...a, ...Array<string>(8 - a.length - b.length).fill("0"), ...b]
    : a;
  return (
    parts
      .slice(0, 4)
      .map((part) => Number.parseInt(part, 16).toString(16))
      .join(":") + "::/64"
  );
}

export function createAliasLimiter(
  now: () => number = Date.now,
  capacity = 10_000,
) {
  const anonymous = new Map<string, { count: number; expires: number }>();
  const authenticated = new Map<string, { count: number; expires: number }>();
  const consume = (buckets: typeof anonymous, key: string, max: number) => {
    const time = now();
    const existing = buckets.get(key);
    const bucket =
      !existing || existing.expires <= time
        ? { count: 0, expires: time + 60_000 }
        : existing;
    bucket.count++;
    buckets.delete(key);
    if (buckets.size >= capacity) {
      const oldest = buckets.keys().next().value;
      if (oldest !== undefined) buckets.delete(oldest);
    }
    buckets.set(key, bucket);
    return bucket.count <= max;
  };
  return {
    ip: (ip: string) => consume(anonymous, networkBucket(ip), 60),
    key: (id: string) => consume(authenticated, `key:${id}`, 20),
    user: (id: string) => consume(authenticated, `user:${id}`, 20),
    send: (id: string) => consume(authenticated, `send:${id}`, 30),
  };
}
