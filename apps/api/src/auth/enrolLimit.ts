/** Failed enrolments per IP: more than 5 in 15 minutes → 429 (04 §6). In-memory, per isolate. */
const WINDOW_MS = 15 * 60_000;
const MAX_FAILS = 5;
const CAP = 10_000;
const AFTER_EVICT = 9_000;
const fails = new Map<string, number[]>();

function recent(ip: string, now: number): number[] {
  const list = (fails.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  if (list.length === 0) fails.delete(ip);
  else fails.set(ip, list);
  return list;
}

function evictOldest(): void {
  if (fails.size <= CAP) return;
  const ranked = [...fails.entries()].sort(
    (a, b) => (a[1].at(-1) ?? 0) - (b[1].at(-1) ?? 0),
  );
  for (const [key] of ranked) {
    if (fails.size <= AFTER_EVICT) break;
    fails.delete(key);
  }
}

export function enrolBlocked(ip: string, now: number): boolean {
  return recent(ip, now).length >= MAX_FAILS;
}

export function recordEnrolFailure(ip: string, now: number): void {
  const list = recent(ip, now);
  list.push(now);
  fails.set(ip, list);
  evictOldest();
}

/** Test hook. */
export function resetEnrolLimit(): void {
  fails.clear();
}

/** Test hook. */
export function enrolLimitSize(): number {
  return fails.size;
}
