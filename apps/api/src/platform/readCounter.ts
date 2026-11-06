/**
 * Rows read by pull and snapshot, kept in memory per isolate and added to `tenant_usage` with the
 * tenant's next push (13 §6: best effort, so reads cost no extra writes).
 */
type PendingReads = { day: string; rows: number };

const pending = new Map<string, PendingReads>();

function utcDay(): string {
  return new Date().toISOString().slice(0, 10);
}

export function addRowsRead(tenantId: string, rows: number): void {
  if (rows <= 0) return;
  const day = utcDay();
  const current = pending.get(tenantId);
  if (current?.day === day) current.rows += rows;
  else pending.set(tenantId, { day, rows });
}

/** Pending reads for today only; yesterday's unflushed rows must not block a new day. */
export function pendingRowsRead(tenantId: string): number {
  const current = pending.get(tenantId);
  return current?.day === utcDay() ? current.rows : 0;
}

export function takeRowsRead(tenantId: string): number {
  const current = pending.get(tenantId);
  pending.delete(tenantId);
  return current?.day === utcDay() ? current.rows : 0;
}
