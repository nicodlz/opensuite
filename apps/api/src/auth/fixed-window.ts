type Bucket = { count: number; until: number };
export function createFixedWindow(
  now: () => number = Date.now,
  capacity = 10_000,
  evict = false,
) {
  const buckets = new Map<string, Bucket>();
  let nextSweep = 0;
  const consume = (key: string, max: number, windowMs = 60_000) => {
    const current = now();
    if (current >= nextSweep) {
      for (const [name, bucket] of buckets)
        if (bucket.until <= current) buckets.delete(name);
      nextSweep = current + 60_000;
    }
    const old = buckets.get(key);
    if (!old && buckets.size >= capacity) {
      if (!evict) return { retryAfter: 60, first: false };
      const oldest = buckets.keys().next().value;
      if (oldest !== undefined) buckets.delete(oldest);
    }
    const bucket =
      !old || old.until <= current
        ? { count: 0, until: current + windowMs }
        : old;
    bucket.count++;
    if (evict) buckets.delete(key);
    buckets.set(key, bucket);
    return bucket.count > max
      ? {
          retryAfter: Math.max(1, Math.ceil((bucket.until - current) / 1000)),
          first: bucket.count === max + 1,
        }
      : undefined;
  };
  return { consume };
}
