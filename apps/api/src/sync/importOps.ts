/** Unsynced-ops import for a revoked device (03 §8; 04 §3.7–3.8). */
import type { TenantDb } from '../db/tenantDb.ts';
import { ApiError } from '../errors.ts';
import { takeRowsRead } from '../platform/readCounter.ts';
import { usageStatement, usageTodayStatement } from '../platform/tenants.ts';
import { assertQuota } from '../routes/sync.ts';
import type { DeviceRow, TenantRow } from '../types.ts';
import { applyOps, CallBudget } from './applyOps.ts';
import type { PushOp } from './opSchema.ts';
import { supportPayload, tenantStatusPayload } from './status.ts';

/** Whole transactions created before `limit` (read-only shops import only those, 13 §7.2). */
export function opsBefore(ops: PushOp[], limit: number): PushOp[] {
  const ok = new Map<string, boolean>();
  for (const op of ops) {
    const created = op.created_at ?? op.row?.updated_at ?? op.row?.created_at;
    const fine = typeof created === 'number' && created < limit;
    ok.set(op.tx_id, (ok.get(op.tx_id) ?? true) && fine);
  }
  return ops.filter((op) => ok.get(op.tx_id) === true);
}

export async function importOps(
  env: Env,
  db: TenantDb,
  tenant: TenantRow,
  deviceId: string,
  ops: PushOp[],
  now: number,
) {
  const budget = new CallBudget();
  budget.take(3);
  // The device and today's usage are independent: one batch replaces two round trips.
  const [deviceRow, usageRow] = await db.batch([
    db.prepare(
      'SELECT * FROM devices WHERE tenant_id = ?1 AND id = ?2',
      deviceId,
    ),
    usageTodayStatement(env, tenant.id, now),
  ]);
  const device = (deviceRow?.results?.[0] as DeviceRow | undefined) ?? null;
  if (!device)
    throw new ApiError('NOT_FOUND', 404, 'No such device in this shop');
  if (device.revoked_at === null)
    throw new ApiError(
      'FORBIDDEN',
      403,
      'Only a revoked device’s ops can be imported',
    );
  if (device.kind === 'support')
    throw new ApiError(
      'FORBIDDEN',
      403,
      'Support access is view-only; its ops cannot be imported',
    );
  const usage = (usageRow?.results?.[0] as
    | { rows_written: number }
    | undefined) ?? { rows_written: 0 };
  assertQuota(tenant, usage, now);
  const eligible =
    tenant.status === 'read_only' && tenant.status_changed_at !== null
      ? opsBefore(ops, tenant.status_changed_at)
      : ops;
  const outcome =
    eligible.length > 0
      ? await applyOps(
          {
            db,
            tenant,
            device,
            now,
            budget,
            deviceSeenAt: Number(device.last_seen_at ?? 0),
          },
          eligible,
        )
      : { results: [], rowsWritten: 0, rowsRead: 0, tail: [] };
  // The usage row and the latest seq close in one batch instead of two round trips.
  const tailResults = await db.batch([
    ...outcome.tail,
    usageStatement(env, tenant.id, now, {
      pushes: 1,
      rows_written: outcome.rowsWritten,
      rows_read: outcome.rowsRead + takeRowsRead(tenant.id),
    }),
    db.prepare('SELECT MAX(seq) AS seq FROM change_log WHERE tenant_id = ?1'),
  ]);
  const latest =
    (tailResults.at(-1)?.results?.[0] as { seq?: number | null } | undefined)
      ?.seq ?? tenant.change_log_floor;
  return {
    results: outcome.results,
    server_time: now,
    latest_seq: latest,
    tenant_status: tenantStatusPayload(tenant),
    support: supportPayload(tenant, now),
  };
}
