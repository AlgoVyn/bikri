/** Failed enrolments per IP: more than 5 in 15 minutes → 429 (04 §6). In-memory, per isolate. */
const WINDOW_MS = 15 * 60_000;
const MAX_FAILS = 5;
const fails = new Map<string, number[]>();

function recent(ip: string, now: number): number[] {
  const list = (fails.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  if (list.length === 0) fails.delete(ip);
  else fails.set(ip, list);
  return list;
}

export function enrolBlocked(ip: string, now: number): boolean {
  return recent(ip, now).length >= MAX_FAILS;
}

export function recordEnrolFailure(ip: string, now: number): void {
  const list = recent(ip, now);
  list.push(now);
  fails.set(ip, list);
  if (fails.size > 10_000) fails.clear();
}

/** Test hook. */
export function resetEnrolLimit(): void {
  fails.clear();
}
