import type { Context } from 'hono';
import { pollAfterMs, usageToday } from '../platform/tenants.ts';
import { latestSeq } from '../sync/changeLog.ts';
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
  const seen = readOnlySeenStatement(db, tenant, device, now);
  if (seen) await seen.run();
  await endExpiredSupport(db, tenant, now);
  const [shop, seq, usage] = await Promise.all([
    db.first<{ setup_completed_at: number | null }>(
      'SELECT setup_completed_at FROM shop WHERE tenant_id = ?1',
    ),
    latestSeq(db, tenant.change_log_floor),
    usageToday(c.env, tenant.id, now),
  ]);
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
    latest_seq: seq,
  });
}
