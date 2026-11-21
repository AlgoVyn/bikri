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
  usage: UsageRow;
};

type TenantJoin = {
  tenant_slug: string;
  tenant_display_name: string;
  tenant_status: TenantRow['status'];
  tenant_status_reason: string;
  tenant_status_changed_at: number | null;
  tenant_status_changed_by: string | null;
  tenant_db_shard: string;
  tenant_daily_write_budget: number;
  tenant_poll_after_ms: number;
  tenant_restore_epoch: string;
  tenant_restore_point_at: number;
  tenant_change_log_floor: number;
  tenant_note: string;
  tenant_owner_email: string | null;
  tenant_last_owner_export_at: number | null;
  tenant_file_bytes: number;
  tenant_files_initialized: number;
  tenant_support_until: number | null;
  tenant_support_reason: string;
  tenant_created_by_email: string;
  tenant_created_at: number;
  tenant_updated_at: number;
  tenant_deleted_at: number | null;
  usage_pushes: number | null;
  usage_rows_written: number | null;
  usage_rows_read: number | null;
};

/**
 * The device holding this token hash (token hashes are globally unique) and its tenant.
 *
 * One join, not two sequential D1 round trips: every device request pays this before it
 * can run, and the token hash alone decides the tenant. The join is tenant-safe because
 * `devices.token_hash` is globally unique; it never accepts a tenant from the client.
 */
export async function deviceByTokenHash(
  env: Env,
  tokenHash: string,
  now: number,
): Promise<DeviceWithTenant | null> {
  const row = await env.DB.prepare(
    `SELECT d.*,
       t.slug AS tenant_slug,
       t.display_name AS tenant_display_name,
       t.status AS tenant_status,
       t.status_reason AS tenant_status_reason,
       t.status_changed_at AS tenant_status_changed_at,
       t.status_changed_by AS tenant_status_changed_by,
       t.db_shard AS tenant_db_shard,
       t.daily_write_budget AS tenant_daily_write_budget,
       t.poll_after_ms AS tenant_poll_after_ms,
       t.restore_epoch AS tenant_restore_epoch,
       t.restore_point_at AS tenant_restore_point_at,
       t.change_log_floor AS tenant_change_log_floor,
       t.note AS tenant_note,
       t.owner_email AS tenant_owner_email,
       t.last_owner_export_at AS tenant_last_owner_export_at,
       t.file_bytes AS tenant_file_bytes,
       t.files_initialized AS tenant_files_initialized,
       t.support_until AS tenant_support_until,
       t.support_reason AS tenant_support_reason,
       t.created_by_email AS tenant_created_by_email,
       t.created_at AS tenant_created_at,
       t.updated_at AS tenant_updated_at,
       t.deleted_at AS tenant_deleted_at,
       u.pushes AS usage_pushes,
       u.rows_written AS usage_rows_written,
       u.rows_read AS usage_rows_read
     FROM devices d
     JOIN tenants t ON t.id = d.tenant_id
     LEFT JOIN tenant_usage u ON u.tenant_id = t.id AND u.day = ?2
     WHERE d.token_hash = ?1`,
  )
    .bind(tokenHash, utcDay(now))
    .first<DeviceRow & { tenant_id: string } & TenantJoin>();
  if (!row) return null;
  const {
    tenant_slug,
    tenant_display_name,
    usage_pushes,
    usage_rows_written,
    usage_rows_read,
    ...rest
  } = row;
  const usage: UsageRow = {
    pushes: Number(usage_pushes ?? 0),
    rows_written: Number(usage_rows_written ?? 0),
    rows_read: Number(usage_rows_read ?? 0),
  };
  const tenant: TenantRow = {
    id: rest.tenant_id,
    slug: tenant_slug,
    display_name: tenant_display_name,
    status: rest.tenant_status,
    status_reason: rest.tenant_status_reason,
    status_changed_at: rest.tenant_status_changed_at,
    status_changed_by: rest.tenant_status_changed_by,
    db_shard: rest.tenant_db_shard,
    daily_write_budget: rest.tenant_daily_write_budget,
    poll_after_ms: rest.tenant_poll_after_ms,
    restore_epoch: rest.tenant_restore_epoch,
    restore_point_at: rest.tenant_restore_point_at,
    change_log_floor: rest.tenant_change_log_floor,
    note: rest.tenant_note,
    owner_email: rest.tenant_owner_email,
    last_owner_export_at: rest.tenant_last_owner_export_at,
    file_bytes: rest.tenant_file_bytes,
    files_initialized: rest.tenant_files_initialized,
    support_until: rest.tenant_support_until,
    support_reason: rest.tenant_support_reason,
    created_by_email: rest.tenant_created_by_email,
    created_at: rest.tenant_created_at,
    updated_at: rest.tenant_updated_at,
    deleted_at: rest.tenant_deleted_at,
  };
  const device = { ...rest } as Record<string, unknown>;
  for (const key of Object.keys(device))
    if (key.startsWith('tenant_')) delete device[key];
  return { device: device as DeviceRow & { tenant_id: string }, tenant, usage };
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

/** Today's usage row, prepared for a caller's batch or a direct read. */
export function usageTodayStatement(
  env: Env,
  tenantId: string,
  now: number,
): D1PreparedStatement {
  return env.DB.prepare(
    'SELECT pushes, rows_written, rows_read FROM tenant_usage WHERE tenant_id = ?1 AND day = ?2',
  ).bind(tenantId, utcDay(now));
}

/** A direct usage read for paths outside the device-auth pipeline (ops import, admin). */
export async function usageToday(
  env: Env,
  tenantId: string,
  now: number,
): Promise<UsageRow> {
  const row = await usageTodayStatement(env, tenantId, now).first<UsageRow>();
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
