import type { Context } from 'hono';
import { z } from 'zod';
import { ApiError } from '../errors.ts';
import { addRowsRead, takeRowsRead } from '../platform/readCounter.ts';
import {
  pollAfterMs,
  secondsToUtcMidnight,
  usageStatement,
  usageToday,
} from '../platform/tenants.ts';
import { applyOps, CallBudget } from '../sync/applyOps.ts';
import { latestSeq } from '../sync/changeLog.ts';
import { PullQuery, PushBody, type PushOp } from '../sync/opSchema.ts';
import {
  readOnlySeenStatement,
  supportPayload,
  tenantStatusPayload,
} from '../sync/status.ts';
import { SNAPSHOT_TABLES, selectList } from '../sync/tables.ts';
import type { AppEnv, DeviceRow, TenantRow } from '../types.ts';

const MAX_PUSH_BYTES = 1_000_000;
/** Allowance for a slow device clock after the device learned the shop is read-only (13 §7.2). */
export const READ_ONLY_GRACE_MS = 10 * 60_000;

function readOnlyError(tenant: TenantRow): ApiError {
  return new ApiError('TENANT_READ_ONLY', 403, 'This shop is read-only', {
    since: tenant.status_changed_at,
  });
}

/** Ops eligible in a read-only shop: whole transactions created before the device knew (13 §7.2). */
export function readOnlyEligible(
  ops: PushOp[],
  seenAt: number | null,
): PushOp[] {
  if (seenAt === null) return ops;
  const limit = seenAt + READ_ONLY_GRACE_MS;
  const ok = new Map<string, boolean>();
  for (const op of ops) {
    const created = op.row?.created_at;
    const fine = typeof created === 'number' && created <= limit;
    ok.set(op.tx_id, (ok.get(op.tx_id) ?? true) && fine);
  }
  return ops.filter((op) => ok.get(op.tx_id) === true);
}

/** Quota gate before a push (13 §6). */
export async function assertQuota(
  env: Env,
  tenant: TenantRow,
  now: number,
): Promise<void> {
  const usage = await usageToday(env, tenant.id, now);
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
  const length = Number(c.req.header('content-length') ?? '0');
  if (length > MAX_PUSH_BYTES)
    throw new ApiError('PAYLOAD_TOO_LARGE', 413, 'Push body is over 1 MB');
  const text = await c.req.text();
  if (text.length > MAX_PUSH_BYTES)
    throw new ApiError('PAYLOAD_TOO_LARGE', 413, 'Push body is over 1 MB');
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
  await assertQuota(c.env, tenant, now);

  let ops = body.ops;
  const tail: D1PreparedStatement[] = [];
  if (tenant.status === 'read_only') {
    const seenBefore = device.read_only_seen_at;
    ops = readOnlyEligible(ops, seenBefore);
    if (ops.length === 0) throw readOnlyError(tenant);
    const seen = readOnlySeenStatement(db, tenant, device, now);
    if (seen) tail.push(seen);
  }

  const budget = new CallBudget();
  budget.take(3); // device look-up, tenant, usage read
  const outcome = await applyOps({ db, tenant, device, now, budget }, ops);
  tail.push(...outcome.tail);
  tail.push(
    usageStatement(c.env, tenant.id, now, {
      pushes: 1,
      rows_written: outcome.rowsWritten,
      rows_read: outcome.rowsRead + takeRowsRead(tenant.id),
    }),
  );
  await db.batch(tail);
  return c.json({
    results: outcome.results,
    server_time: now,
    latest_seq: await latestSeq(db, tenant.change_log_floor),
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

/** `GET /api/sync/pull?since=&limit=` (03 §4.2). */
export async function pull(c: Context<AppEnv>): Promise<Response> {
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
  const rows = await db.select<ChangeRow>(
    'SELECT seq, tbl, row_id, op, row_json FROM change_log WHERE tenant_id = ?1 AND seq > ?2 ORDER BY seq LIMIT ?3',
    q.since,
    q.limit + 1,
  );
  const page = rows.slice(0, q.limit);
  addRowsRead(tenant.id, page.length);
  const usage = await usageToday(c.env, tenant.id, now);
  return c.json({
    changes: page.map((r) => ({
      seq: r.seq,
      tbl: r.tbl,
      op: r.op,
      row: JSON.parse(r.row_json) as unknown,
    })),
    next_since: page.at(-1)?.seq ?? q.since,
    has_more: rows.length > q.limit,
    server_time: now,
    restore_epoch: tenant.restore_epoch,
    restore_point_at: tenant.restore_point_at,
    poll_after_ms: pollAfterMs(tenant, usage),
    tenant_status: tenantStatusPayload(tenant),
    support: supportPayload(tenant, now),
  });
}

export const SnapshotQuery = z.object({
  tbl: z.enum(SNAPSHOT_TABLES).optional(),
  after: z.string().max(40).default(''),
  limit: z.coerce.number().int().min(1).max(1000).default(500),
});

/** Snapshot start (counts) and pages, shared by the till snapshot and exports (03 §4.3). */
export async function snapshotPayload(
  c: Context<AppEnv>,
  db: AppEnv['Variables']['db'],
  tenant: TenantRow,
  maxLimit = 1000,
): Promise<Record<string, unknown>> {
  const q = SnapshotQuery.parse({
    tbl: c.req.query('tbl') || undefined,
    after: c.req.query('after') ?? '',
    limit: c.req.query('limit') ?? undefined,
  });
  if (!q.tbl) {
    const seq = await latestSeq(db, tenant.change_log_floor);
    const res = await db.batch(
      SNAPSHOT_TABLES.map((tbl) =>
        db.prepare(`SELECT COUNT(*) AS n FROM ${tbl} WHERE tenant_id = ?1`),
      ),
    );
    return {
      snapshot_seq: seq,
      tables: SNAPSHOT_TABLES.map((tbl, i) => ({
        tbl,
        rows: Number(
          (res[i]?.results?.[0] as { n?: number } | undefined)?.n ?? 0,
        ),
      })),
    };
  }
  const limit = Math.min(q.limit, maxLimit);
  const rows = await db.select(
    `SELECT ${selectList(q.tbl)} FROM ${q.tbl} WHERE tenant_id = ?1 AND id > ?2 ORDER BY id LIMIT ?3`,
    q.after,
    limit + 1,
  );
  const page = rows.slice(0, limit);
  addRowsRead(tenant.id, page.length);
  return {
    tbl: q.tbl,
    rows: page,
    next_after: page.length > 0 ? String(page.at(-1)?.id ?? '') : q.after,
    has_more: rows.length > limit,
  };
}

/** `GET /api/sync/snapshot` (03 §4.3). */
export async function snapshot(c: Context<AppEnv>): Promise<Response> {
  const { tenant, db } = c.var;
  return c.json(await snapshotPayload(c, db, tenant));
}
