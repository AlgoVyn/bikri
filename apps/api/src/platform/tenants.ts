/**
 * Platform-level reads and writes on `tenants`, `tenant_usage` and the two global hash look-ups
 * (device token, enrolment code) that must run before the tenant is known (13 §5). Raw `env.DB`
 * is allowed only here and in db/tenantDb.ts; every statement still names the tenant or a
 * globally unique hash.
 */
import type { DeviceRow, TenantRow } from '../types.ts';

export async function getTenant(
  env: Env,
  id: string,
): Promise<TenantRow | null> {
  return env.DB.prepare('SELECT * FROM tenants WHERE id = ?1')
    .bind(id)
    .first<TenantRow>();
}

export type DeviceWithTenant = {
  device: DeviceRow & { tenant_id: string };
  tenant: TenantRow;
};

/** The device holding this token hash (token hashes are globally unique) and its tenant. */
export async function deviceByTokenHash(
  env: Env,
  tokenHash: string,
): Promise<DeviceWithTenant | null> {
  const device = await env.DB.prepare(
    'SELECT * FROM devices WHERE token_hash = ?1',
  )
    .bind(tokenHash)
    .first<DeviceRow & { tenant_id: string }>();
  if (!device) return null;
  const tenant = await getTenant(env, device.tenant_id);
  return tenant ? { device, tenant } : null;
}

export type EnrolmentCodeRow = {
  code_hash: string;
  tenant_id: string;
  device_name: string;
  branch_id: string;
  grants_admin: number;
  kind: 'till' | 'support';
  created_by: string;
  created_at: number;
  expires_at: number;
  used_at: number | null;
  device_id: string | null;
};

/** An enrolment code by its hash (code hashes are globally unique and decide the tenant). */
export async function enrolmentCodeByHash(
  env: Env,
  codeHash: string,
): Promise<EnrolmentCodeRow | null> {
  return env.DB.prepare('SELECT * FROM enrolment_codes WHERE code_hash = ?1')
    .bind(codeHash)
    .first<EnrolmentCodeRow>();
}

/** UTC day `YYYY-MM-DD` (D1 limits reset at 00:00 UTC). */
export function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

/** Seconds until the next 00:00 UTC. */
export function secondsToUtcMidnight(now: number): number {
  const next = new Date(now);
  next.setUTCHours(24, 0, 0, 0);
  return Math.max(1, Math.ceil((next.getTime() - now) / 1000));
}

export type UsageRow = {
  pushes: number;
  rows_written: number;
  rows_read: number;
};

export async function usageToday(
  env: Env,
  tenantId: string,
  now: number,
): Promise<UsageRow> {
  const row = await env.DB.prepare(
    'SELECT pushes, rows_written, rows_read FROM tenant_usage WHERE tenant_id = ?1 AND day = ?2',
  )
    .bind(tenantId, utcDay(now))
    .first<UsageRow>();
  return row ?? { pushes: 0, rows_written: 0, rows_read: 0 };
}

/** The usage upsert that ends every push batch (03 §4.1 step 6). */
export function usageStatement(
  env: Env,
  tenantId: string,
  now: number,
  add: { pushes: number; rows_written: number; rows_read: number },
): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO tenant_usage (tenant_id, day, pushes, rows_written, rows_read) VALUES (?1, ?2, ?3, ?4, ?5)
     ON CONFLICT (tenant_id, day) DO UPDATE SET pushes = pushes + excluded.pushes,
       rows_written = rows_written + excluded.rows_written, rows_read = rows_read + excluded.rows_read`,
  ).bind(tenantId, utcDay(now), add.pushes, add.rows_written, add.rows_read);
}

/** Effective poll interval: doubled while the tenant is above 80 % of its write budget (13 §6). */
export function pollAfterMs(tenant: TenantRow, usage: UsageRow): number {
  const budget = tenant.daily_write_budget;
  const hot = budget === 0 || usage.rows_written > budget * 0.8;
  return hot
    ? Math.min(tenant.poll_after_ms * 2, 3_600_000)
    : tenant.poll_after_ms;
}
