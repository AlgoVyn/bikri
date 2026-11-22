/**
 * A category's share of the period total, as a whole percent (screens/14). Dividing by
 * the largest category made every top row print 100%; a total of zero has no shares.
 */
export function categorySharePercent(net: number, total: number): number {
  if (!Number.isFinite(net) || !Number.isFinite(total) || total <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((net / total) * 100)));
}
