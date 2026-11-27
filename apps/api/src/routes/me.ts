import type { Context } from 'hono';
import { pollAfterMs } from '../platform/tenants.ts';
import { publicDevice } from '../sync/devices.ts';
import {
  endExpiredSupport,
  readOnlySeenStatement,
  supportPayload,
  tenantStatusPayload,
} from '../sync/status.ts';
import type { AppEnv } from '../types.ts';

/** `GET /api/me` (04 §3.3). */
export async function me(c: Context<AppEnv>): Promise<Response> {
  const { tenant, device, db, usage } = c.var;
  const now = Date.now();
  await endExpiredSupport(c.env, db, tenant, now);

  // Every device request starts here. Read the setup flag and the latest change seq
  // in one D1 batch; today's usage was joined into the device-token lookup.
  // The read-only acknowledgement joins the same batch. v1 uses a single shard
  // (`shardOf` always returns `DB`), so all statements share one `batch`.
  const statements: D1PreparedStatement[] = [];
  const seen = readOnlySeenStatement(db, tenant, device, now);
  if (seen) statements.push(seen);
  const shopAt =
    statements.push(
      db.prepare('SELECT setup_completed_at FROM shop WHERE tenant_id = ?1'),
    ) - 1;
  const seqAt =
    statements.push(
      db.prepare('SELECT MAX(seq) AS seq FROM change_log WHERE tenant_id = ?1'),
    ) - 1;
  const results = await db.batch(statements);
  const first = (index: number) =>
    (results[index]?.results?.[0] ?? undefined) as
      | Record<string, unknown>
      | undefined;
  const shop = first(shopAt) as
    | { setup_completed_at?: number | null }
    | undefined;
  const seq = first(seqAt) as { seq?: number | null } | undefined;

  return c.json({
    tenant: {
      id: tenant.id,
      display_name: tenant.display_name,
      status: tenant.status,
    },
    tenant_status: tenantStatusPayload(tenant),
    support: supportPayload(tenant, now),
    device: publicDevice(device),
    shop_setup_completed: Boolean(shop?.setup_completed_at),
    poll_after_ms: pollAfterMs(tenant, usage),
    server_time: now,
    latest_seq: seq?.seq ?? tenant.change_log_floor,
  });
}
