import type { TenantDb } from '../db/tenantDb.ts';
import type { DeviceRow, TenantRow } from '../types.ts';
import { auditStatements } from './audit.ts';
import { changeLogStatement } from './changeLog.ts';

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

/** Revokes support devices with their `change_log` rows. */
export async function revokeSupportDevices(
  db: TenantDb,
  now: number,
): Promise<D1PreparedStatement[]> {
  const live = await db.select<{ id: string }>(
    "SELECT id FROM devices WHERE tenant_id = ?1 AND kind = 'support' AND revoked_at IS NULL",
  );
  return live.flatMap(({ id }) => [
    db.prepare(
      'UPDATE devices SET revoked_at = ?2, updated_at = ?2 WHERE tenant_id = ?1 AND id = ?3',
      now,
      id,
    ),
    changeLogStatement(db, 'devices', id, 'upsert', null, now),
  ]);
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
  const revoke = await revokeSupportDevices(db, now);
  if (revoke.length === 0) return false;
  await db.batch([
    ...revoke,
    ...auditStatements(db, {
      action: 'support_access_end',
      after: { ended_by: 'expiry' },
      now,
    }),
  ]);
  return true;
}
