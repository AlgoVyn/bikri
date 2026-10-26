/** Platform-level D1 access (no tenant tables). Raw `env.DB` is allowed only here and in db/tenantDb.ts (13 §5). */

/** True when the primary database answers a trivial query. */
export async function primaryDbReachable(env: Env): Promise<boolean> {
  try {
    await env.DB.prepare('SELECT 1').first();
    return true;
  } catch {
    return false;
  }
}
