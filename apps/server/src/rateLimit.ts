const hits = new Map<string, number[]>();

export function allowRate(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const arr = hits.get(key) ?? [];
  const pruned = arr.filter((t) => now - t < windowMs);
  if (pruned.length >= limit) {
    hits.set(key, pruned);
    return false;
  }
  pruned.push(now);
  hits.set(key, pruned);
  return true;
}
