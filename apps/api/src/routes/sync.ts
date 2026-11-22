import type { Context } from 'hono';
import { z } from 'zod';
import { ApiError } from '../errors.ts';
import { readTextBody } from '../middleware/body.ts';
import {
  addRowsRead,
  pendingRowsRead,
  takeRowsRead,
} from '../platform/readCounter.ts';
import {
  pollAfterMs,
  secondsToUtcMidnight,
  usageStatement,
} from '../platform/tenants.ts';
import { applyOps, CallBudget } from '../sync/applyOps.ts';
import { latestSeq } from '../sync/changeLog.ts';
import { PullQuery, PushBody, type PushOp } from '../sync/opSchema.ts';
import {
  readOnlySeenStatement,
  supportPayload,
  tenantStatusPayload,
} from '../sync/status.ts';
import { columnsOf, SNAPSHOT_TABLES, selectList } from '../sync/tables.ts';
import type { AppEnv, DeviceRow, TenantRow } from '../types.ts';

const MAX_PUSH_BYTES = 1_000_000;
/** Allowance for a slow device clock after the device learned the shop is read-only (13 §7.2). */
export const READ_ONLY_GRACE_MS = 10 * 60_000;

function readOnlyError(tenant: TenantRow): ApiError {
  return new ApiError('TENANT_READ_ONLY', 403, 'This shop is read-only', {
    since: tenant.status_changed_at,
  });
}

/**
 * Ops eligible in a read-only shop: whole transactions created before the device knew (13 §7.2).
 *
 * `readOnlySeenStatement` persists the first answer the device received — from `/me`, pull,
 * snapshot or a rejected push — and the grace is measured from it. Push-first used to keep
 * measuring from `status_changed_at` because it never persisted the acknowledgement, so a
 * till that pushed first was refused ops a `/me`-first till would have kept (API-M5).
 */
export function readOnlyEligible(
  ops: PushOp[],
  seenAt: number | null,
  statusChangedAt: number | null = null,
): PushOp[] {
  const origin = seenAt ?? statusChangedAt;
  if (origin === null) return ops;
  const limit = origin + READ_ONLY_GRACE_MS;
  const ok = new Map<string, boolean>();
  for (const op of ops) {
    const created = op.created_at ?? op.row?.updated_at ?? op.row?.created_at;
    const fine = typeof created === 'number' && created <= limit;
    ok.set(op.tx_id, (ok.get(op.tx_id) ?? true) && fine);
  }
  return ops.filter((op) => ok.get(op.tx_id) === true);
}

/** Quota gate before a push (13 §6). */
export function assertQuota(
  tenant: TenantRow,
  usage: { rows_written: number },
  now: number,
): void {
  if (usage.rows_written >= tenant.daily_write_budget) {
    const wait = secondsToUtcMidnight(now);
    throw new ApiError(
      'TENANT_QUOTA',
      503,
      'This shop reached its daily sync limit',
      { retry_after: wait },
      {
        'Retry-After': String(wait),
      },
    );
  }
}

/** A shop cannot read the shared D1 budget without bound (13 §6). */
export const READ_BUDGET_FLOOR = 1_000_000;

export function assertReadQuota(
  tenant: TenantRow,
  usage: { rows_read: number },
): void {
  const cap = Math.max(
    READ_BUDGET_FLOOR,
    Number(tenant.daily_write_budget) * 50,
  );
  if (usage.rows_read + pendingRowsRead(tenant.id) < cap) return;
  const wait = secondsToUtcMidnight(Date.now());
  throw new ApiError(
    'TENANT_QUOTA',
    503,
    'This shop reached its daily download limit',
    { retry_after: wait },
    { 'Retry-After': String(wait) },
  );
}

export function assertCanWrite(device: DeviceRow): void {
  if (device.kind === 'support') {
    throw new ApiError('FORBIDDEN', 403, 'Support devices are view-only');
  }
}

/** `POST /api/sync/push` (03 §4.1). */
export async function push(c: Context<AppEnv>): Promise<Response> {
  const { tenant, device, db } = c.var;
  const now = Date.now();
  assertCanWrite(device);
  const text = await readTextBody(c, MAX_PUSH_BYTES);
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ApiError('VALIDATION_FAILED', 400, 'Body is not JSON');
  }
  const version = z.object({ schema_version: z.number().int() }).safeParse(raw);
  if (
    version.success &&
    version.data.schema_version < Number(c.env.MIN_CLIENT_SCHEMA)
  ) {
    throw new ApiError(
      'SCHEMA_OUTDATED',
      409,
      'Update the app to keep syncing',
      {
        min_client_schema: Number(c.env.MIN_CLIENT_SCHEMA),
      },
    );
  }
  const body = PushBody.parse(raw);
  if (body.device_id !== device.id)
    throw new ApiError('FORBIDDEN', 403, 'device_id is not this device');
  assertQuota(tenant, c.var.usage, now);

  let ops = body.ops;
  const tail: D1PreparedStatement[] = [];
  if (tenant.status === 'read_only') {
    const seenBefore = device.read_only_seen_at;
    ops = readOnlyEligible(ops, seenBefore, tenant.status_changed_at);
    const seen = readOnlySeenStatement(db, tenant, device, now);
    if (ops.length === 0) {
      // Persist the acknowledgement even on the 403, so a push-first till uses the same
      // cutoff as one that called /me or /pull first (API-M5).
      if (seen) await seen.run();
      throw readOnlyError(tenant);
    }
    if (seen) tail.push(seen);
  }

  const budget = new CallBudget();
  budget.take(3); // token look-up, the closing batch and one spare
  const outcome = await applyOps({ db, tenant, device, now, budget }, ops);
  tail.push(...outcome.tail);
  tail.push(
    usageStatement(c.env, tenant.id, now, {
      pushes: 1,
      rows_written: outcome.rowsWritten,
      rows_read: outcome.rowsRead + takeRowsRead(tenant.id),
    }),
  );
  // Read the latest seq in the same batch instead of a second round trip.
  tail.push(
    db.prepare('SELECT MAX(seq) AS seq FROM change_log WHERE tenant_id = ?1'),
  );
  const tailResults = await db.batch(tail);
  const latest =
    (tailResults.at(-1)?.results?.[0] as { seq?: number | null } | undefined)
      ?.seq ?? tenant.change_log_floor;
  return c.json({
    results: outcome.results,
    server_time: now,
    latest_seq: latest,
    tenant_status: tenantStatusPayload(tenant),
    support: supportPayload(tenant, now),
  });
}

type ChangeRow = {
  seq: number;
  tbl: string;
  row_id: string;
  op: 'upsert' | 'delete';
  row_json: string;
};

/** Pull/snapshot speak the schema the till was built for; an outdated till must update first. */
function assertClientSchema(c: Context<AppEnv>): number {
  const raw = c.req.header('x-bikri-schema');
  const version = raw === undefined ? Number.NaN : Number(raw);
  const min = Number(c.env.MIN_CLIENT_SCHEMA);
  if (!Number.isSafeInteger(version) || version < min)
    throw new ApiError(
      'SCHEMA_OUTDATED',
      409,
      'Update the app to keep syncing',
      {
        min_client_schema: min,
      },
    );
  return version;
}

/** Bundle columns (and the bundle discount) require the current schema. */
/** Bundles shipped in client schema 5; this gates the feature, not the current schema. */
const BUNDLE_SCHEMA = 5;

/** `GET /api/sync/pull?since=&limit=` (03 §4.2). */
export async function pull(c: Context<AppEnv>): Promise<Response> {
  const clientSchema = assertClientSchema(c);
  const { tenant, device, db } = c.var;
  const now = Date.now();
  const q = PullQuery.parse({
    since: c.req.query('since'),
    limit: c.req.query('limit') ?? undefined,
  });
  if (q.since < tenant.change_log_floor) {
    throw new ApiError(
      'SNAPSHOT_REQUIRED',
      410,
      'This till must download the shop again',
      {
        change_log_floor: tenant.change_log_floor,
      },
    );
  }
  const seen = readOnlySeenStatement(db, tenant, device, now);
  if (seen) await seen.run();
  // Check before the SELECT: a page that crosses the cap must not be read and then
  // discarded, otherwise a blocked till keeps consuming the budget it is over.
  const usage = c.var.usage;
  assertReadQuota(tenant, usage);
  // The rows and the prune floor move independently between the auth lookup and this
  // page. Read both in one D1 batch: the floor used to be an extra round trip on 75%
  // of all Worker traffic.
  const [rowsResult, floorResult] = await db.batch([
    db.prepare(
      'SELECT seq, tbl, row_id, op, row_json FROM change_log WHERE tenant_id = ?1 AND seq > ?2 ORDER BY seq LIMIT ?3',
      q.since,
      q.limit + 1,
    ),
    db.prepare('SELECT change_log_floor FROM tenants WHERE id = ?1'),
  ]);
  const rows = (rowsResult?.results ?? []) as unknown as ChangeRow[];
  // The prune can raise the floor between the device lookup and this SELECT. Re-read it
  // so a page that starts inside a pruned gap never advances the till past missing rows.
  const floor = (floorResult?.results?.[0] ?? undefined) as
    | { change_log_floor?: number }
    | undefined;
  if (floor && Number(floor.change_log_floor) > q.since) {
    throw new ApiError(
      'SNAPSHOT_REQUIRED',
      410,
      'This till must download the shop again',
      { change_log_floor: Number(floor.change_log_floor) },
    );
  }
  const rawPage = rows.slice(0, q.limit);
  const page = rawPage.filter((row) => {
    if (clientSchema >= BUNDLE_SCHEMA) return true;
    if (row.tbl === 'bundle_items') return false;
    if (row.tbl !== 'products') return true;
    try {
      const parsed = JSON.parse(row.row_json) as { kind?: unknown };
      return parsed.kind !== 'bundle';
    } catch {
      return true;
    }
  });
  addRowsRead(tenant.id, Number(rowsResult?.meta?.rows_read ?? rawPage.length));
  // Read-only shops and support devices never push, so their reads would stay in the
  // isolate until it evicts. Flush in coarse 5,000-row batches instead of one write per
  // pull (API-L6).
  if (
    (tenant.status === 'read_only' || device.kind === 'support') &&
    pendingRowsRead(tenant.id) >= 5_000
  ) {
    const rows = takeRowsRead(tenant.id);
    if (rows > 0) {
      await db
        .prepare(
          'INSERT INTO tenant_usage (tenant_id, day, rows_read) VALUES (?1, ?2, ?3) ON CONFLICT (tenant_id, day) DO UPDATE SET rows_read = rows_read + ?3',
          new Date().toISOString().slice(0, 10),
          rows,
        )
        .run();
    }
  }
  // SQLite already holds valid row JSON. Embed it raw instead of parsing every row
  // only to have c.json stringify the whole page again on catch-up pulls.
  const changes = page
    .map(
      (row) =>
        `{"seq":${Number(row.seq)},"tbl":${JSON.stringify(row.tbl)},"op":${JSON.stringify(row.op)},"row":${row.row_json}}`,
    )
    .join(',');
  const meta = JSON.stringify({
    // Advance past hidden bundle rows even when the visible page is shorter.
    next_since: rawPage.at(-1)?.seq ?? q.since,
    has_more: rows.length > q.limit,
    server_time: now,
    restore_epoch: tenant.restore_epoch,
    restore_point_at: tenant.restore_point_at,
    poll_after_ms: pollAfterMs(tenant, usage),
    tenant_status: tenantStatusPayload(tenant),
    support: supportPayload(tenant, now),
  });
  return c.body(`{"changes":[${changes}],${meta.slice(1)}`, 200, {
    'content-type': 'application/json; charset=utf-8',
  });
}

export const SnapshotQuery = z.object({
  tbl: z.enum(SNAPSHOT_TABLES).optional(),
  after: z.string().max(40).default(''),
  limit: z.coerce.number().int().min(1).max(1000).default(500),
  /** Export cut-off: rows created after this are left out so children never outrun parents. */
  before: z.coerce.number().int().positive().optional(),
});

/** Snapshot start and pages, shared by the till snapshot and exports (03 §4.3). */
export async function snapshotPayload(
  query: (key: string) => string | undefined,
  db: AppEnv['Variables']['db'],
  tenant: TenantRow,
  maxLimit = 1000,
  clientSchema = BUNDLE_SCHEMA,
  chargeReads = true,
): Promise<Record<string, unknown>> {
  const tables =
    clientSchema >= BUNDLE_SCHEMA
      ? SNAPSHOT_TABLES
      : SNAPSHOT_TABLES.filter((tbl) => tbl !== 'bundle_items');
  const q = SnapshotQuery.parse({
    tbl: query('tbl') || undefined,
    after: query('after') ?? '',
    limit: query('limit') ?? undefined,
    before: query('before') ?? undefined,
  });
  // `sync_conflicts` records its time in `at`; the other export tables use `created_at`.
  const cutoffColumn = (tbl: string): string | null =>
    tbl === 'sync_conflicts'
      ? 'at'
      : columnsOf(tbl as Parameters<typeof columnsOf>[0]).includes('created_at')
        ? 'created_at'
        : null;
  if (!q.tbl) {
    const seq = await latestSeq(db, tenant.change_log_floor);
    // No per-table `COUNT(*)`: it scans every row, is charged to the same read budget
    // as the pages, and made a large snapshot block before its first page. The till,
    // owner and operator exports all derive progress from the rows they download.
    return {
      snapshot_seq: seq,
      tables: tables.map((tbl) => ({ tbl, rows: 0 })),
    };
  }
  if (q.tbl === 'bundle_items' && clientSchema < BUNDLE_SCHEMA)
    return {
      tbl: q.tbl,
      rows: [],
      next_after: q.after,
      has_more: false,
    };
  const limit = Math.min(q.limit, maxLimit);
  const column = q.before === undefined ? null : cutoffColumn(q.tbl);
  const hideBundles = clientSchema < BUNDLE_SCHEMA && q.tbl === 'products';
  const rows = await db.select(
    `SELECT ${selectList(q.tbl)} FROM ${q.tbl} WHERE tenant_id = ?1 AND id > ?2${column ? ` AND ${column} <= ?3` : ''}${hideBundles ? " AND kind <> 'bundle'" : ''} ORDER BY id LIMIT ?${column ? 4 : 3}`,
    ...(column
      ? [q.after, q.before as number, limit + 1]
      : [q.after, limit + 1]),
  );
  const page = rows.slice(0, limit);
  // The operator export is Access-only and deliberately outside the shop's read
  // budget; till snapshots and owner exports still charge their pages.
  if (chargeReads) addRowsRead(tenant.id, page.length);
  return {
    tbl: q.tbl,
    rows: page,
    next_after: page.length > 0 ? String(page.at(-1)?.id ?? '') : q.after,
    has_more: rows.length > limit,
  };
}

/** `GET /api/sync/snapshot` (03 §4.3). */
export async function snapshot(c: Context<AppEnv>): Promise<Response> {
  const clientSchema = assertClientSchema(c);
  const { tenant, device, db } = c.var;
  const now = Date.now();
  assertReadQuota(tenant, c.var.usage);
  // A snapshot is also a first successful request for a restored/new till. Teach it
  // the current tenant status just like /me and pull, and mark read-only seen.
  const seen = readOnlySeenStatement(db, tenant, device, now);
  if (seen) await seen.run();
  return c.json({
    ...(await snapshotPayload(
      (k) => c.req.query(k),
      db,
      tenant,
      1000,
      clientSchema,
    )),
    server_time: now,
    tenant_status: tenantStatusPayload(tenant),
    support: supportPayload(tenant, now),
  });
}
