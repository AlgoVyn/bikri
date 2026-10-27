import type { D1Table } from '@bikri/db/tables';
import type { SqlValue, TenantDb } from '../db/tenantDb.ts';
import { rowJsonExpr } from './tables.ts';

/**
 * Appends a `change_log` row with the row **as stored** (03 §4.1 step 4), built inside the same
 * batch so it sees the write before it.
 */
export function changeLogStatement(
  db: TenantDb,
  tbl: D1Table,
  rowId: string,
  op: 'upsert' | 'delete',
  deviceId: string | null,
  at: number,
): D1PreparedStatement {
  const params: SqlValue[] = [tbl, op, deviceId, at, rowId];
  return db.prepare(
    `INSERT INTO change_log (tenant_id, tbl, row_id, op, row_json, device_id, at) SELECT ?1, ?2, id, ?3, ${rowJsonExpr(tbl)}, ?4, ?5 FROM ${tbl} WHERE tenant_id = ?1 AND id = ?6`,
    ...params,
  );
}

/** Highest change_log seq of the tenant, or its prune floor when it has no rows. */
export async function latestSeq(db: TenantDb, floor: number): Promise<number> {
  const row = await db.first<{ seq: number | null }>(
    'SELECT MAX(seq) AS seq FROM change_log WHERE tenant_id = ?1',
  );
  return row?.seq ?? floor;
}
