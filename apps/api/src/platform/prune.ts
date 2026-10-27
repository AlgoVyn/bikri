/** Retention prune and tenant deletion (03 §4.4, 13 §7.4). Raw D1 allowed here (platform/). */
import { tenantDb } from '../db/tenantDb.ts';
import { auditStatements } from '../sync/audit.ts';
import { revokeSupportDevices } from '../sync/status.ts';
import { APPLY_ORDER } from '../sync/tables.ts';
import type { TenantRow } from '../types.ts';

export const MAX_CRON_CALLS = 40;
const DAY = 86_400_000;
const LOG_CHUNK = 5_000;
const LOG_MAX_PER_RUN = 50_000;
const DELETE_CHUNK = 2_000;
const DELETE_MAX_PER_RUN = 20_000;

/** Tables of a tenant, children first, for deletion (13 §7.4). */
export const DELETE_ORDER = [
  'owner_email_codes',
  'enrolment_codes',
  'applied_ops',
  'sync_conflicts',
  'change_log',
  'devices',
  ...[...APPLY_ORDER].reverse(),
] as const;

export type PruneReport = {
  calls: number;
  change_log: Record<string, number>;
  applied_ops: number;
  deleted_rows: Record<string, number>;
  deleted_tenants: string[];
  support_ended: string[];
};

class Calls {
  used = 0;
  ok(n = 1): boolean {
    return this.used + n <= MAX_CRON_CALLS;
  }
  async run<T>(fn: () => Promise<T>): Promise<T> {
    this.used += 1;
    return fn();
  }
}

export async function pruneAll(env: Env, now: number): Promise<PruneReport> {
  const calls = new Calls();
  const report: PruneReport = {
    calls: 0,
    change_log: {},
    applied_ops: 0,
    deleted_rows: {},
    deleted_tenants: [],
    support_ended: [],
  };
  const DB = env.DB;
  const cutoff = now - 30 * DAY;

  // 1–2. change_log older than 30 days, per tenant, round-robin from meta.prune_cursor.
  const [targets, cursorRow] = await calls.run(() =>
    DB.batch([
      DB.prepare(
        'SELECT tenant_id, MAX(seq) AS target FROM change_log WHERE at < ?1 GROUP BY tenant_id ORDER BY tenant_id',
      ).bind(cutoff),
      DB.prepare("SELECT value FROM meta WHERE key = 'prune_cursor'"),
    ]),
  );
  const list = (targets?.results ?? []) as Array<{
    tenant_id: string;
    target: number;
  }>;
  const cursor = String(
    (cursorRow?.results?.[0] as { value?: string } | undefined)?.value ?? '',
  );
  const startAt = Math.max(
    0,
    list.findIndex((t) => t.tenant_id > cursor),
  );
  const ordered = [...list.slice(startAt), ...list.slice(0, startAt)];
  let budget = LOG_MAX_PER_RUN;
  let lastTenant = cursor;
  for (const { tenant_id, target } of ordered) {
    if (budget <= 0 || !calls.ok(3)) break;
    const floorRow = await calls.run(() =>
      DB.prepare('SELECT change_log_floor FROM tenants WHERE id = ?1')
        .bind(tenant_id)
        .first<{ change_log_floor: number }>(),
    );
    let floor = floorRow?.change_log_floor ?? 0;
    while (floor < target && budget > 0 && calls.ok(2)) {
      const upto = await calls.run(() =>
        DB.prepare(
          'SELECT MAX(seq) AS upto FROM (SELECT seq FROM change_log WHERE tenant_id = ?1 AND seq > ?2 AND seq <= ?3 ORDER BY seq LIMIT ?4)',
        )
          .bind(tenant_id, floor, target, Math.min(LOG_CHUNK, budget))
          .first<{ upto: number | null }>(),
      );
      const next = upto?.upto ?? target;
      const [del] = await calls.run(() =>
        DB.batch([
          DB.prepare(
            'DELETE FROM change_log WHERE tenant_id = ?1 AND seq > ?2 AND seq <= ?3',
          ).bind(tenant_id, floor, next),
          DB.prepare(
            'UPDATE tenants SET change_log_floor = ?2 WHERE id = ?1 AND change_log_floor < ?2',
          ).bind(tenant_id, next),
        ]),
      );
      const n = del?.meta.changes ?? 0;
      budget -= n;
      report.change_log[tenant_id] = (report.change_log[tenant_id] ?? 0) + n;
      floor = next;
    }
    lastTenant = tenant_id;
  }
  if (calls.ok()) {
    await calls.run(() =>
      DB.prepare("UPDATE meta SET value = ?1 WHERE key = 'prune_cursor'")
        .bind(budget <= 0 ? lastTenant : '')
        .run(),
    );
  }

  // 3–4. applied_ops (90 days), expired codes, old usage rows.
  if (calls.ok()) {
    const day90 = new Date(now - 90 * DAY).toISOString().slice(0, 10);
    const res = await calls.run(() =>
      DB.batch([
        DB.prepare(
          'DELETE FROM applied_ops WHERE rowid IN (SELECT rowid FROM applied_ops WHERE applied_at < ?1 LIMIT 5000)',
        ).bind(now - 90 * DAY),
        DB.prepare('DELETE FROM enrolment_codes WHERE expires_at < ?1').bind(
          now - DAY,
        ),
        DB.prepare('DELETE FROM owner_email_codes WHERE expires_at < ?1').bind(
          now - DAY,
        ),
        DB.prepare('DELETE FROM tenant_usage WHERE day < ?1').bind(day90),
      ]),
    );
    report.applied_ops = res[0]?.meta.changes ?? 0;
  }

  // 4b. support access that ran out with live support devices (13 §7.5).
  if (calls.ok()) {
    const expired = await calls.run(() =>
      DB.prepare(
        "SELECT t.* FROM tenants t WHERE t.support_until IS NOT NULL AND t.support_until <= ?1 AND EXISTS (SELECT 1 FROM devices d WHERE d.tenant_id = t.id AND d.kind = 'support' AND d.revoked_at IS NULL)",
      )
        .bind(now)
        .all<TenantRow>(),
    );
    for (const tenant of expired.results) {
      if (!calls.ok(2)) break;
      const db = tenantDb(env, tenant);
      const revoke = await calls.run(() => revokeSupportDevices(db, now));
      await calls.run(() =>
        db.batch([
          ...revoke,
          ...auditStatements(db, {
            action: 'support_access_end',
            after: { ended_by: 'expiry' },
            now,
          }),
        ]),
      );
      report.support_ended.push(tenant.id);
    }
  }

  // 5. tenant deletion, children first, ≤ 20,000 rows per night (13 §7.4).
  if (calls.ok()) {
    const deleting = await calls.run(() =>
      DB.prepare(
        "SELECT id, db_shard FROM tenants WHERE status = 'deleting' ORDER BY id",
      ).all<{ id: string; db_shard: string }>(),
    );
    let left = DELETE_MAX_PER_RUN;
    for (const t of deleting.results) {
      let empty = true;
      for (const tbl of DELETE_ORDER) {
        while (left > 0 && calls.ok(2)) {
          const res = await calls.run(() =>
            DB.prepare(
              `DELETE FROM ${tbl} WHERE rowid IN (SELECT rowid FROM ${tbl} WHERE tenant_id = ?1 LIMIT ?2)`,
            )
              .bind(t.id, Math.min(DELETE_CHUNK, left))
              .run(),
          );
          const n = res.meta.changes ?? 0;
          left -= n;
          report.deleted_rows[t.id] = (report.deleted_rows[t.id] ?? 0) + n;
          if (n < Math.min(DELETE_CHUNK, left + n)) break;
        }
        if (left <= 0 || !calls.ok(2)) {
          empty = false;
          break;
        }
      }
      if (!empty) break;
      // R2 objects under t/<tenant>/ (list + delete; deletes are free).
      let more = true;
      while (more && calls.ok(3)) {
        const listed = await calls.run(() =>
          env.FILES.list({ prefix: `t/${t.id}/`, limit: 1000 }),
        );
        if (listed.objects.length > 0)
          await calls.run(() =>
            env.FILES.delete(listed.objects.map((o) => o.key)),
          );
        more = listed.truncated;
      }
      if (more || !calls.ok(2)) break;
      const usage = await calls.run(() =>
        DB.batch([
          DB.prepare('DELETE FROM tenant_usage WHERE tenant_id = ?1').bind(
            t.id,
          ),
          DB.prepare(
            "UPDATE tenants SET status = 'deleted', deleted_at = ?2, owner_email = NULL, updated_at = ?2, status_changed_at = ?2, status_changed_by = 'cron' WHERE id = ?1",
          ).bind(t.id, now),
        ]),
      );
      if (usage) report.deleted_tenants.push(t.id);
    }
  }

  if (calls.ok()) {
    await calls.run(() =>
      DB.prepare("UPDATE meta SET value = ?1 WHERE key = 'last_prune_at'")
        .bind(String(now))
        .run(),
    );
  }
  report.calls = calls.used;
  return report;
}
