/**
 * Tenant-leading pagination for operator purge and nightly tenant deletion (H8).
 *
 * `DELETE … WHERE tenant_id = ?1 … rowid IN (SELECT rowid … ORDER BY rowid DESC LIMIT ?2)`
 * made SQLite scan every remaining row of the tenant twice per chunk and build a TEMP
 * B-tree for the sort, i.e. O(N²) reads over a large shop. Every statement below instead
 * pages by the table's tenant-leading key, so the outer delete is a set of index equality
 * probes and the inner page is a reverse index scan stopped by LIMIT.
 */

/**
 * The tenant-leading key of each table deleted by the purge/tenant-delete loops. Most
 * tenant tables use `(tenant_id, id)`; `change_log` has a global `seq`, `applied_tx` a
 * `tx_id`, `change_log_watermarks` a `day`,
 * `branch_device_codes` a composite `(branch_id, device_code)`, and `enrolment_codes`
 * has no tenant-leading primary key (its `code_hash` is global), so it pages on the
 * `(tenant_id, expires_at)` index.
 */
const DELETE_KEYS: Readonly<Record<string, readonly string[]>> = {
  change_log: ['seq'],
  change_log_watermarks: ['day'],
  applied_tx: ['tx_id'],
  branch_device_codes: ['branch_id', 'device_code'],
  enrolment_codes: ['expires_at'],
};

export function tenantDeleteKey(tbl: string): readonly string[] {
  return DELETE_KEYS[tbl] ?? ['id'];
}

/**
 * One bounded delete chunk. `where` is a trusted pass predicate (for example the
 * child-before-parent pass on `sales`/`expenses`), never client input.
 */
export function tenantDeleteChunkSql(tbl: string, where: string): string {
  const keys = tenantDeleteKey(tbl);
  const columns = keys.join(', ');
  const tuple = keys.length === 1 ? columns : `(${columns})`;
  const order = keys.map((key) => `${key} DESC`).join(', ');
  return `DELETE FROM ${tbl} WHERE tenant_id = ?1 AND ${where} AND ${tuple} IN (SELECT ${columns} FROM ${tbl} WHERE tenant_id = ?1 AND ${where} ORDER BY ${order} LIMIT ?2)`;
}
