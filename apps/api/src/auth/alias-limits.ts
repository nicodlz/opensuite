import { createFixedWindow } from "./fixed-window.ts";
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
  const anonymous = createFixedWindow(now, capacity, true);
  const keys = createFixedWindow(now, capacity);
  const users = createFixedWindow(now, capacity);
  const sends = createFixedWindow(now, capacity);
  const mutations = createFixedWindow(now, capacity);
  return {
    ip: (ip: string) => anonymous.consume(networkBucket(ip), 60) === undefined,
    key: (id: string) => keys.consume(id, 20) === undefined,
    user: (id: string) => users.consume(id, 20) === undefined,
    send: (id: string) => sends.consume(id, 30) === undefined,
    mutate: (id: string) => mutations.consume(id, 60) === undefined,
  };
}
