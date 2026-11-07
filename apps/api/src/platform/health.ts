/** Platform-level D1 access (no tenant tables). Raw `env.DB` is allowed only here and in db/tenantDb.ts (13 §5). */

let cached: { at: number; ok: boolean } | null = null;
const CACHE_MS = 30_000;

/**
 * True when the primary database answers a trivial query. The public health endpoint
 * is unauthenticated, so cache the result per isolate instead of letting anonymous
 * traffic consume the shared D1 read budget.
 */
export async function primaryDbReachable(
  env: Env,
  now = Date.now(),
): Promise<boolean> {
  if (cached !== null && now - cached.at < CACHE_MS) return cached.ok;
  let ok = false;
  try {
    await env.DB.prepare('SELECT 1').first();
    ok = true;
  } catch {
    ok = false;
  }
  cached = { at: now, ok };
  return ok;
}
