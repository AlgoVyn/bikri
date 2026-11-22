import type { TenantDb } from '../db/tenantDb.ts';
import type { DeviceRow, TenantRow } from '../types.ts';
import { auditStatements } from './audit.ts';
import { rowJsonExpr } from './tables.ts';

export type TenantStatusPayload = {
  status: 'active' | 'read_only';
  since: number | null;
};

/** `tenant_status` of /api/me, pull and push (04 §3.3). */
export function tenantStatusPayload(tenant: TenantRow): TenantStatusPayload {
  return tenant.status === 'read_only'
    ? { status: 'read_only', since: tenant.status_changed_at }
    : { status: 'active', since: null };
}

/** `support` of /api/me and pull: active operator support access, else null (13 §7.5). */
export function supportPayload(
  tenant: TenantRow,
  now: number,
): { until: number; reason: string } | null {
  return tenant.support_until !== null && tenant.support_until > now
    ? { until: tenant.support_until, reason: tenant.support_reason }
    : null;
}

/** First read-only answer to a device: remember when it learned it (13 §7.2). */
export function readOnlySeenStatement(
  db: TenantDb,
  tenant: TenantRow,
  device: DeviceRow,
  now: number,
): D1PreparedStatement | null {
  if (tenant.status !== 'read_only' || device.read_only_seen_at !== null)
    return null;
  device.read_only_seen_at = now;
  return db.prepare(
    'UPDATE devices SET read_only_seen_at = ?2 WHERE tenant_id = ?1 AND id = ?3 AND read_only_seen_at IS NULL',
    now,
    device.id,
  );
}

/**
 * Statements that revoke every live support device and publish the change (13 §7.5).
 *
 * They run inside the caller's own `db.batch()`, so a support enrolment that committed
 * before that batch is revoked too. The old read-then-batch left a window where a device
 * enrolled between the SELECT and the batch kept access until `expires_at` (API-H4).
 * `deviceAuth` also refuses a support token once `tenants.support_until` has passed.
 */
export function revokeSupportDeviceStatements(
  db: TenantDb,
  now: number,
): D1PreparedStatement[] {
  return [
    db.prepare(
      "UPDATE devices SET revoked_at = ?2, updated_at = ?2 WHERE tenant_id = ?1 AND kind = 'support' AND revoked_at IS NULL",
      now,
    ),
    // `changes()` is still the UPDATE's row count for the first statement after it.
    db.prepare(
      `INSERT INTO change_log (tenant_id, tbl, row_id, op, row_json, device_id, at) SELECT ?1, 'devices', id, 'upsert', ${rowJsonExpr('devices')}, NULL, ?2 FROM devices WHERE tenant_id = ?1 AND kind = 'support' AND revoked_at = ?2 AND changes() > 0`,
      now,
    ),
  ];
}

/**
 * Support time ran out but support devices are still live: revoke them and write
 * `support_access_end` (ended_by 'expiry'), once (13 §7.5). Returns true when it ended access.
 */
export async function endExpiredSupport(
  db: TenantDb,
  tenant: TenantRow,
  now: number,
): Promise<boolean> {
  if (tenant.support_until === null || tenant.support_until > now) return false;
  const [revoked] = await db.batch(revokeSupportDeviceStatements(db, now));
  if ((revoked?.meta.changes ?? 0) === 0) return false;
  await db.batch(
    auditStatements(db, {
      action: 'support_access_end',
      after: { ended_by: 'expiry' },
      now,
    }),
  );
  return true;
}
