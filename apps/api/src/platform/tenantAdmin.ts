/** Platform-table reads and writes for the operator console (04 §3.7). Raw D1 allowed here. */
import { tenantDb } from '../db/tenantDb.ts';
import { auditStatements } from '../sync/audit.ts';
import type { TenantRow, TenantStatus } from '../types.ts';
import { utcDay } from './tenants.ts';

export async function tenantById(
  env: Env,
  id: string,
): Promise<TenantRow | null> {
  return env.DB.prepare('SELECT * FROM tenants WHERE id = ?1')
    .bind(id)
    .first<TenantRow>();
}

export type TenantListRow = {
  id: string;
  slug: string;
  display_name: string;
  status: TenantStatus;
  devices: number;
  last_seen_at: number | null;
  today: { rows_written: number; rows_read: number; pushes: number };
  daily_write_budget: number;
  setup_completed: boolean;
};

export async function listTenants(
  env: Env,
  now: number,
): Promise<{
  tenants: TenantListRow[];
  account_today: { rows_written: number; rows_read: number };
}> {
  const day = utcDay(now);
  const { results } = await env.DB.prepare(
    `SELECT t.id, t.slug, t.display_name, t.status, t.daily_write_budget,
       (SELECT COUNT(*) FROM devices d WHERE d.tenant_id = t.id AND d.revoked_at IS NULL) AS devices,
       (SELECT MAX(last_seen_at) FROM devices d WHERE d.tenant_id = t.id) AS last_seen_at,
       (SELECT COUNT(*) FROM shop s WHERE s.tenant_id = t.id AND s.setup_completed_at IS NOT NULL) AS setup,
       COALESCE(u.rows_written, 0) AS rows_written, COALESCE(u.rows_read, 0) AS rows_read, COALESCE(u.pushes, 0) AS pushes
     FROM tenants t LEFT JOIN tenant_usage u ON u.tenant_id = t.id AND u.day = ?1
     WHERE t.status <> 'deleted' ORDER BY t.display_name`,
  )
    .bind(day)
    .all<Record<string, number | string | null>>();
  let w = 0;
  let r = 0;
  const tenants = results.map((row) => {
    w += Number(row.rows_written);
    r += Number(row.rows_read);
    return {
      id: String(row.id),
      slug: String(row.slug),
      display_name: String(row.display_name),
      status: row.status as TenantStatus,
      devices: Number(row.devices),
      last_seen_at: row.last_seen_at === null ? null : Number(row.last_seen_at),
      today: {
        rows_written: Number(row.rows_written),
        rows_read: Number(row.rows_read),
        pushes: Number(row.pushes),
      },
      daily_write_budget: Number(row.daily_write_budget),
      setup_completed: Number(row.setup) > 0,
    };
  });
  return { tenants, account_today: { rows_written: w, rows_read: r } };
}

export async function usageHistory(env: Env, tenantId: string, days = 7) {
  const { results } = await env.DB.prepare(
    'SELECT day, pushes, rows_written, rows_read FROM tenant_usage WHERE tenant_id = ?1 ORDER BY day DESC LIMIT ?2',
  )
    .bind(tenantId, days)
    .all<{
      day: string;
      pushes: number;
      rows_written: number;
      rows_read: number;
    }>();
  return results.reverse();
}

/** Account-wide figures for the console Overview (screens/19). */
export async function accountOverview(env: Env, now: number) {
  const day = utcDay(now);
  const [size, statuses] = await env.DB.batch([
    env.DB.prepare(
      'SELECT COALESCE(SUM(rows_written), 0) AS w, COALESCE(SUM(rows_read), 0) AS r FROM tenant_usage WHERE day = ?1',
    ).bind(day),
    env.DB.prepare('SELECT status, COUNT(*) AS n FROM tenants GROUP BY status'),
  ]);
  const totals = (size?.results?.[0] ?? { w: 0, r: 0 }) as {
    w: number;
    r: number;
  };
  const by: Record<string, number> = {};
  for (const row of (statuses?.results ?? []) as {
    status: string;
    n: number;
  }[])
    by[row.status] = row.n;
  return {
    db_size_bytes: size?.meta.size_after ?? null,
    today: { rows_written: totals.w, rows_read: totals.r },
    tenants_by_status: by,
  };
}

export type TenantPatch = {
  display_name?: string;
  daily_write_budget?: number;
  poll_after_ms?: number;
  note?: string;
  owner_email?: string | null;
};

export function patchTenantStatement(
  env: Env,
  id: string,
  patch: TenantPatch,
  now: number,
): D1PreparedStatement | null {
  const cols = Object.keys(patch).filter((k) =>
    [
      'display_name',
      'daily_write_budget',
      'poll_after_ms',
      'note',
      'owner_email',
    ].includes(k),
  ) as (keyof TenantPatch)[];
  if (cols.length === 0) return null;
  const set = cols.map((c, i) => `${c} = ?${i + 3}`).join(', ');
  return env.DB.prepare(
    `UPDATE tenants SET ${set}, updated_at = ?2 WHERE id = ?1`,
  ).bind(id, now, ...cols.map((c) => patch[c] ?? null));
}

export function maskEmail(email: string): string {
  const [user = '', domain = ''] = email.split('@');
  return `${user.slice(0, 1)}***@${domain}`;
}

/** Allowed operator transitions (04 §3.7). */
export function statusChangeAllowed(
  from: TenantStatus,
  to: TenantStatus,
): boolean {
  if (from === to) return false;
  if (to === 'read_only') return from === 'active' || from === 'suspended';
  if (to === 'active')
    return (
      from === 'read_only' || from === 'suspended' || from === 'maintenance'
    );
  if (to === 'suspended') return from === 'active' || from === 'read_only';
  if (to === 'maintenance')
    return from === 'active' || from === 'read_only' || from === 'suspended';
  if (to === 'deleting') return from !== 'deleted' && from !== 'deleting';
  return false;
}

/** Status change with its `tenant_status_change` audit row in one batch (13 §7.2). */
export function statusChangeStatements(
  env: Env,
  tenant: TenantRow,
  to: TenantStatus,
  reason: string,
  by: string,
  now: number,
): D1PreparedStatement[] {
  const db = tenantDb(env, tenant);
  const out: D1PreparedStatement[] = [
    env.DB.prepare(
      'UPDATE tenants SET status = ?2, status_reason = ?3, status_changed_at = ?4, status_changed_by = ?5, updated_at = ?4 WHERE id = ?1 AND status = ?6',
    ).bind(tenant.id, to, reason, now, by, tenant.status),
    ...auditStatements(db, {
      action: 'tenant_status_change',
      entity: 'shop',
      before: { status: tenant.status },
      after: { from: tenant.status, to, reason, by },
      now,
    }),
  ];
  if (tenant.status === 'read_only' && to !== 'read_only') {
    out.push(
      db.prepare(
        'UPDATE devices SET read_only_seen_at = NULL WHERE tenant_id = ?1 AND read_only_seen_at IS NOT NULL',
      ),
    );
  }
  if (to === 'deleting') {
    out.push(
      db.prepare(
        'UPDATE devices SET revoked_at = ?2, updated_at = ?2 WHERE tenant_id = ?1 AND revoked_at IS NULL',
        now,
      ),
    );
  }
  return out;
}

export function supportStatement(
  env: Env,
  tenantId: string,
  until: number,
  reason: string,
  now: number,
) {
  return env.DB.prepare(
    'UPDATE tenants SET support_until = ?2, support_reason = ?3, updated_at = ?4 WHERE id = ?1',
  ).bind(tenantId, until, reason, now);
}

export function restoreEpochStatement(
  env: Env,
  tenantId: string,
  restorePointAt: number,
  now: number,
) {
  return env.DB.prepare(
    'UPDATE tenants SET restore_epoch = ?2, restore_point_at = ?3, updated_at = ?4 WHERE id = ?1',
  ).bind(tenantId, String(now), restorePointAt, now);
}

export function ownerExportStatement(env: Env, tenantId: string, now: number) {
  return env.DB.prepare(
    'UPDATE tenants SET last_owner_export_at = ?2 WHERE id = ?1',
  ).bind(tenantId, now);
}

export async function tenantBySlug(
  env: Env,
  slug: string,
): Promise<TenantRow | null> {
  return env.DB.prepare('SELECT * FROM tenants WHERE slug = ?1')
    .bind(slug)
    .first<TenantRow>();
}
