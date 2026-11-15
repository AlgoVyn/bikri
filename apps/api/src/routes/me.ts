import type { Context } from 'hono';
import {
  pollAfterMs,
  type UsageRow,
  usageTodayStatement,
} from '../platform/tenants.ts';
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
  const { tenant, device, db } = c.var;
  const now = Date.now();
  await endExpiredSupport(db, tenant, now);

  // Every device request starts here. Read the setup flag, the latest change seq and
  // today's usage in one D1 batch: three sequential round trips made `/me` the slowest
  // path of a reconnect, and the read-only acknowledgement joins the same batch.
  // v1 uses a single shard (`shardOf` always returns `DB`), so the platform usage
  // statement and the tenant-scoped statements share one `batch`.
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
  const usageAt =
    statements.push(usageTodayStatement(c.env, tenant.id, now)) - 1;
  const results = await db.batch(statements);
  const first = (index: number) =>
    (results[index]?.results?.[0] ?? undefined) as
      | Record<string, unknown>
      | undefined;
  const shop = first(shopAt) as
    | { setup_completed_at?: number | null }
    | undefined;
  const seq = first(seqAt) as { seq?: number | null } | undefined;
  const usage =
    (first(usageAt) as UsageRow | undefined) ??
    ({ pushes: 0, rows_written: 0, rows_read: 0 } satisfies UsageRow);

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
