/** Unsynced-ops import for a revoked device (03 §8; 04 §3.7–3.8). */
import type { TenantDb } from '../db/tenantDb.ts';
import { ApiError } from '../errors.ts';
import { takeRowsRead } from '../platform/readCounter.ts';
import { usageStatement } from '../platform/tenants.ts';
import type { DeviceRow, TenantRow } from '../types.ts';
import { applyOps, CallBudget } from './applyOps.ts';
import { latestSeq } from './changeLog.ts';
import type { PushOp } from './opSchema.ts';

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
  const device = await db.first<DeviceRow>(
    'SELECT * FROM devices WHERE tenant_id = ?1 AND id = ?2',
    deviceId,
  );
  if (!device)
    throw new ApiError('NOT_FOUND', 404, 'No such device in this shop');
  if (device.revoked_at === null)
    throw new ApiError(
      'FORBIDDEN',
      403,
      'Only a revoked device’s ops can be imported',
    );
  const eligible =
    tenant.status === 'read_only' && tenant.status_changed_at !== null
      ? opsBefore(ops, tenant.status_changed_at)
      : ops;
  const budget = new CallBudget();
  budget.take(3);
  const outcome =
    eligible.length > 0
      ? await applyOps({ db, tenant, device, now, budget }, eligible)
      : { results: [], rowsWritten: 0, rowsRead: 0, tail: [] };
  await db.batch([
    ...outcome.tail,
    usageStatement(env, tenant.id, now, {
      pushes: 1,
      rows_written: outcome.rowsWritten,
      rows_read: outcome.rowsRead + takeRowsRead(tenant.id),
    }),
  ]);
  return {
    results: outcome.results,
    server_time: now,
    latest_seq: await latestSeq(db, tenant.change_log_floor),
  };
}
