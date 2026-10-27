/**
 * Rows read by pull and snapshot, kept in memory per isolate and added to `tenant_usage` with the
 * tenant's next push (13 §6: best effort, so reads cost no extra writes).
 */
const pending = new Map<string, number>();

export function addRowsRead(tenantId: string, rows: number): void {
  if (rows > 0) pending.set(tenantId, (pending.get(tenantId) ?? 0) + rows);
}

export function takeRowsRead(tenantId: string): number {
  const n = pending.get(tenantId) ?? 0;
  pending.delete(tenantId);
  return n;
}
