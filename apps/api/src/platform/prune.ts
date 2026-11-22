/** Retention prune and tenant deletion (03 §4.4, 13 §7.4). Raw D1 allowed here (platform/). */
import { tenantDb } from '../db/tenantDb.ts';
import { auditStatements } from '../sync/audit.ts';
import { revokeSupportDeviceStatements } from '../sync/status.ts';
import { APPLY_ORDER } from '../sync/tables.ts';
import type { TenantRow } from '../types.ts';
import { utcDay } from './tenants.ts';

export const MAX_CRON_CALLS = 50;
const DAY = 86_400_000;
const LOG_CHUNK = 5_000;
const LOG_MAX_PER_RUN = 50_000;
const DELETE_CHUNK = 2_000;
const DELETE_MAX_PER_RUN = 20_000;
/** At 10 reference shops ~13,500 applied_ops age out per day; the old 5,000 could never keep 90 days. */
const APPLIED_OPS_MAX_PER_RUN = 20_000;
/** Stay below the Free plan's 100k daily rows-written cap, leaving headroom for shops. */
const ACCOUNT_WRITE_BUDGET = 90_000;
const APPLIED_OPS_CHUNK = 5_000;

/** Tables of a tenant, children first, for deletion (13 §7.4). */
export const DELETE_ORDER = [
  'owner_email_codes',
  'enrolment_codes',
  'applied_ops',
  'sync_conflicts',
  'change_log',
  'change_log_watermarks',
  'devices',
  'branch_device_codes',
  ...[...APPLY_ORDER].reverse(),
] as const;

export type PruneReport = {
  calls: number;
  rows_written: number;
  change_log: Record<string, number>;
  applied_ops: number;
  deleted_rows: Record<string, number>;
  deleted_tenants: string[];
  support_ended: string[];
};

class Calls {
  used = 0;
  writes = 0;
  writeLimit = Number.POSITIVE_INFINITY;
  ok(n = 1): boolean {
    return this.used + n <= MAX_CRON_CALLS;
  }
  hasWrites(estimate = 1): boolean {
    return this.writes + estimate <= this.writeLimit;
  }
  writesLeft(): number {
    return Math.max(0, this.writeLimit - this.writes);
  }
  async run<T>(fn: () => Promise<T>): Promise<T> {
    this.used += 1;
    const result = await fn();
    this.writes += writtenRowsOf(result);
    return result;
  }
}

/** D1 reports the real rows written (table + index entries); fall back to changes. */
function writtenRowsOf(result: unknown): number {
  if (Array.isArray(result))
    return result.reduce((sum, item) => sum + writtenRowsOf(item), 0);
  if (result === null || typeof result !== 'object') return 0;
  const meta = (
    result as { meta?: { rows_written?: number; changes?: number } }
  ).meta;
  const rows = Number(meta?.rows_written ?? meta?.changes ?? 0);
  return Number.isFinite(rows) ? rows : 0;
}

export async function pruneAll(env: Env, now: number): Promise<PruneReport> {
  const calls = new Calls();
  const report: PruneReport = {
    calls: 0,
    rows_written: 0,
    change_log: {},
    applied_ops: 0,
    deleted_rows: {},
    deleted_tenants: [],
    support_ended: [],
  };
  const DB = env.DB;
  const cutoff = now - 30 * DAY;

  // 1–2. change_log older than 30 days, per tenant, round-robin from meta.prune_cursor.
  // Each tenant's daily watermark gives its seq ceiling for the cutoff day, so the
  // prune no longer keeps `change_log_prune` (one D1 write per row).
  const cutoffDay = utcDay(cutoff);
  const today = utcDay(now);
  const [tenantRows, cursorRow, usageRow] = await calls.run(() =>
    DB.batch([
      DB.prepare(
        "SELECT id, created_at FROM tenants WHERE status NOT IN ('deleted', 'deleting') ORDER BY id",
      ),
      DB.prepare("SELECT value FROM meta WHERE key = 'prune_cursor'"),
      DB.prepare(
        'SELECT COALESCE(SUM(rows_written), 0) AS n FROM tenant_usage WHERE day = ?1',
      ).bind(today),
    ]),
  );
  const usedToday = Number(
    (usageRow?.results?.[0] as { n?: number } | undefined)?.n ?? 0,
  );
  calls.writeLimit = Math.max(0, ACCOUNT_WRITE_BUDGET - usedToday);
  const tenants = (
    (tenantRows?.results ?? []) as Array<{
      id: string;
      created_at: number;
    }>
  ).map((row) => ({
    id: String(row.id),
    createdAt: Number(row.created_at ?? 0),
  }));
  const tenantIds = tenants.map((tenant) => tenant.id);
  // `undefined` = no watermark covers the cutoff day yet; 0 is a real watermark that says
  // "this shop had nothing old". Conflating the two re-ran the fallback scan every night
  // for 30 nights (API-H7).
  const targetByTenant = new Map<string, number>();
  // Record today's watermark and read each tenant's cutoff watermark in one batch
  // per 40 tenants (two statements each). `deleting` shops are skipped: their log is
  // being deleted and their watermark would leak (API-H7).
  for (let at = 0; at < tenantIds.length; at += 40) {
    const chunk = tenantIds.slice(at, at + 40);
    if (!calls.ok() || !calls.hasWrites(chunk.length * 2)) {
      break;
    }
    const statements: D1PreparedStatement[] = [];
    for (const id of chunk) {
      statements.push(
        DB.prepare(
          `INSERT INTO change_log_watermarks (tenant_id, day, max_seq)
           SELECT ?1, ?2, COALESCE(MAX(seq), 0) FROM change_log WHERE tenant_id = ?1
           ON CONFLICT(tenant_id, day) DO UPDATE SET max_seq =
             CASE WHEN excluded.max_seq > max_seq THEN excluded.max_seq ELSE max_seq END`,
        ).bind(id, today),
        DB.prepare(
          'SELECT max_seq FROM change_log_watermarks WHERE tenant_id = ?1 AND day <= ?2 ORDER BY day DESC LIMIT 1',
        ).bind(id, cutoffDay),
      );
    }
    const results = await calls.run(() => DB.batch(statements));
    chunk.forEach((id, index) => {
      const row = results[index * 2 + 1]?.results?.[0] as
        | { max_seq?: number }
        | undefined;
      if (row?.max_seq !== undefined && row?.max_seq !== null)
        targetByTenant.set(id, Number(row.max_seq));
    });
  }
  // First run after deploy: no watermark covers the cutoff yet. Derive each tenant's
  // ceiling once from the log and store it for the cutoff day — including a real 0, so
  // the next night does not scan again. A shop younger than the cutoff cannot have old
  // rows, so it is skipped until it is old enough (API-H7).
  for (const tenant of tenants) {
    if (targetByTenant.has(tenant.id)) continue;
    if (tenant.createdAt >= cutoff) {
      targetByTenant.set(tenant.id, 0);
      continue;
    }
    if (!calls.ok(2) || !calls.hasWrites(2)) break;
    const old = await calls.run(() =>
      DB.prepare(
        'SELECT MAX(seq) AS n FROM change_log WHERE tenant_id = ?1 AND at < ?2',
      )
        .bind(tenant.id, cutoff)
        .first<{ n: number | null }>(),
    );
    const target = Number(old?.n ?? 0);
    targetByTenant.set(tenant.id, target);
    await calls.run(() =>
      DB.prepare(
        `INSERT INTO change_log_watermarks (tenant_id, day, max_seq) VALUES (?1, ?2, ?3)
         ON CONFLICT(tenant_id, day) DO UPDATE SET max_seq =
           CASE WHEN excluded.max_seq > max_seq THEN excluded.max_seq ELSE max_seq END`,
      )
        .bind(tenant.id, cutoffDay, target)
        .run(),
    );
  }
  const cursor = String(
    (cursorRow?.results?.[0] as { value?: string } | undefined)?.value ?? '',
  );
  const startAt = Math.max(
    0,
    tenantIds.findIndex((id) => id >= cursor),
  );
  const ordered = [...tenantIds.slice(startAt), ...tenantIds.slice(0, startAt)];
  let budget = LOG_MAX_PER_RUN;
  let lastTenant = cursor;
  let completed = true;
  for (const tenant_id of ordered) {
    const target = targetByTenant.get(tenant_id);
    if (target === undefined || target <= 0) {
      lastTenant = tenant_id;
      continue;
    }
    // Leave one call for the cursor write at the end of this pass.
    if (budget <= 0 || !calls.ok(4) || !calls.hasWrites(4)) {
      completed = false;
      break;
    }
    const floorRow = await calls.run(() =>
      DB.prepare('SELECT change_log_floor FROM tenants WHERE id = ?1')
        .bind(tenant_id)
        .first<{ change_log_floor: number }>(),
    );
    let floor = floorRow?.change_log_floor ?? 0;
    if (floor >= target) {
      lastTenant = tenant_id;
      continue;
    }
    while (floor < target && budget > 0 && calls.ok(2)) {
      const limit = Math.min(
        LOG_CHUNK,
        budget,
        Math.floor(calls.writesLeft() / 4),
      );
      if (limit <= 0) {
        completed = false;
        break;
      }
      const upto = await calls.run(() =>
        DB.prepare(
          'SELECT MAX(seq) AS upto FROM (SELECT seq FROM change_log WHERE tenant_id = ?1 AND seq > ?2 AND seq <= ?3 ORDER BY seq LIMIT ?4)',
        )
          .bind(tenant_id, floor, target, limit)
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
  if (calls.ok() && calls.hasWrites(1)) {
    await calls.run(() =>
      DB.prepare("UPDATE meta SET value = ?1 WHERE key = 'prune_cursor'")
        .bind(completed ? '' : lastTenant)
        .run(),
    );
  }

  // 3–4. applied_ops (90 days), expired codes, old usage rows.
  if (calls.ok() && calls.hasWrites(3)) {
    let appliedLeft = APPLIED_OPS_MAX_PER_RUN;
    while (appliedLeft > 0 && calls.ok() && calls.hasWrites(3)) {
      const limit = Math.min(
        APPLIED_OPS_CHUNK,
        appliedLeft,
        Math.floor(calls.writesLeft() / 3),
      );
      if (limit <= 0) break;
      const res = await calls.run(() =>
        DB.prepare(
          'DELETE FROM applied_ops WHERE rowid IN (SELECT rowid FROM applied_ops WHERE applied_at < ?1 LIMIT ?2)',
        )
          .bind(now - 90 * DAY, limit)
          .run(),
      );
      const n = res.meta.changes ?? 0;
      report.applied_ops += n;
      appliedLeft -= n;
      if (n < limit) break;
    }
    if (calls.ok() && calls.hasWrites(100)) {
      const day90 = new Date(now - 90 * DAY).toISOString().slice(0, 10);
      await calls.run(() =>
        DB.batch([
          DB.prepare('DELETE FROM enrolment_codes WHERE expires_at < ?1').bind(
            now - DAY,
          ),
          DB.prepare(
            'DELETE FROM owner_email_codes WHERE expires_at < ?1',
          ).bind(now - DAY),
          DB.prepare('DELETE FROM tenant_usage WHERE day < ?1').bind(day90),
          // Superseded per-day watermarks: only the newest row at or before the cutoff
          // day is read, so older ones would grow without bound (API-H7).
          DB.prepare('DELETE FROM change_log_watermarks WHERE day < ?1').bind(
            cutoffDay,
          ),
          // Public requests hold name/email/phone. A closed request has no operator use
          // after the retention window (09 §9).
          DB.prepare(
            "DELETE FROM shop_requests WHERE status IN ('rejected','failed') AND updated_at < ?1",
          ).bind(now - 30 * DAY),
        ]),
      );
    }
  }

  // 4b. support access that ran out with live support devices (13 §7.5).
  if (calls.ok() && calls.hasWrites(2)) {
    const expired = await calls.run(() =>
      DB.prepare(
        "SELECT t.* FROM tenants t WHERE t.support_until IS NOT NULL AND t.support_until <= ?1 AND EXISTS (SELECT 1 FROM devices d WHERE d.tenant_id = t.id AND d.kind = 'support' AND d.revoked_at IS NULL)",
      )
        .bind(now)
        .all<TenantRow>(),
    );
    for (const tenant of expired.results) {
      if (!calls.ok(2) || !calls.hasWrites(2)) break;
      const db = tenantDb(env, tenant);
      const [revoked] = await calls.run(() =>
        db.batch(revokeSupportDeviceStatements(db, now, true)),
      );
      if ((revoked?.meta.changes ?? 0) === 0) continue;
      await calls.run(() =>
        db.batch(
          auditStatements(db, {
            action: 'support_access_end',
            after: { ended_by: 'expiry' },
            now,
          }),
        ),
      );
      report.support_ended.push(tenant.id);
    }
  }

  // 5. tenant deletion, children first, ≤ 20,000 rows per night (13 §7.4).
  if (calls.ok() && calls.hasWrites(1)) {
    const deleting = await calls.run(() =>
      DB.prepare(
        "SELECT id, db_shard FROM tenants WHERE status = 'deleting' ORDER BY id",
      ).all<{ id: string; db_shard: string }>(),
    );
    let left = DELETE_MAX_PER_RUN;
    // Self-referencing ledger rows (a reissued sale, a reversed expense) must be deleted
    // before the row they point at. A single unordered DELETE can hit the parent first
    // and abort the whole cron on an immediate FK, so use the same two passes as the
    // operator purge.
    const passesFor = (tbl: string): string[] =>
      tbl === 'expenses'
        ? ['reverses_id IS NOT NULL', '1 = 1']
        : tbl === 'sales'
          ? ['replaces_sale_id IS NOT NULL', '1 = 1']
          : ['1 = 1'];
    for (const t of deleting.results) {
      if (left <= 0 || !calls.ok(3) || !calls.hasWrites(5)) break;
      // One probe batch skips empty tables instead of issuing a DELETE for each of them.
      const probes = await calls.run(() =>
        DB.batch(
          DELETE_ORDER.map((tbl) =>
            DB.prepare(
              `SELECT 1 AS x FROM ${tbl} WHERE tenant_id = ?1 LIMIT 1`,
            ).bind(t.id),
          ),
        ),
      );
      const nonEmpty = new Set(
        DELETE_ORDER.filter(
          (_tbl, index) => (probes[index]?.results?.length ?? 0) > 0,
        ),
      );
      let done = true;
      for (const tbl of DELETE_ORDER) {
        if (!nonEmpty.has(tbl)) continue;
        for (const where of passesFor(tbl)) {
          while (left > 0 && calls.ok(2) && calls.hasWrites(5)) {
            const limit = Math.min(
              DELETE_CHUNK,
              left,
              Math.max(1, Math.floor(calls.writesLeft() / 5)),
            );
            const res = await calls.run(() =>
              DB.prepare(
                `DELETE FROM ${tbl} WHERE tenant_id = ?1 AND ${where} AND rowid IN (SELECT rowid FROM ${tbl} WHERE tenant_id = ?1 AND ${where} ORDER BY rowid DESC LIMIT ?2)`,
              )
                .bind(t.id, limit)
                .run(),
            );
            const n = res.meta.changes ?? 0;
            left -= n;
            report.deleted_rows[t.id] = (report.deleted_rows[t.id] ?? 0) + n;
            if (n < limit) break;
          }
          if (left <= 0 || !calls.ok(2) || !calls.hasWrites(1)) {
            done = false;
            break;
          }
        }
        if (!done) break;
      }
      if (!done) break;
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
      if (more || !calls.ok(2) || !calls.hasWrites(3)) break;
      const usage = await calls.run(() =>
        DB.batch([
          DB.prepare('DELETE FROM tenant_usage WHERE tenant_id = ?1').bind(
            t.id,
          ),
          // The public request carries the owner's name, phone and city. It is not a
          // tenant table, so the DELETE_ORDER above never reaches it.
          DB.prepare('DELETE FROM shop_requests WHERE tenant_id = ?1').bind(
            t.id,
          ),
          DB.prepare(
            "UPDATE tenants SET status = 'deleted', deleted_at = ?2, owner_email = NULL, note = '', support_reason = '', support_until = NULL, status_reason = '', file_bytes = 0, files_initialized = 1, updated_at = ?2, status_changed_at = ?2, status_changed_by = 'cron' WHERE id = ?1",
          ).bind(t.id, now),
        ]),
      );
      if (usage) report.deleted_tenants.push(t.id);
    }
  }

  if (calls.ok() && calls.hasWrites(1)) {
    await calls.run(() =>
      DB.prepare("UPDATE meta SET value = ?1 WHERE key = 'last_prune_at'")
        .bind(String(now))
        .run(),
    );
  }
  report.calls = calls.used;
  report.rows_written = calls.writes;
  return report;
}
