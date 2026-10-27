import type { BikriDb, SyncedRow } from '@bikri/db';
import { heldExpiringCount } from './cart.ts';

export type AttentionItem =
  | { kind: 'low_stock'; count: number }
  | { kind: 'promises_due'; count: number }
  | { kind: 'over_limit'; count: number }
  | { kind: 'failed_prints'; count: number }
  | { kind: 'conflicts'; count: number }
  | { kind: 'held_expiring'; count: number }
  | { kind: 'day_not_closed'; date: string };

/** Products with track_stock = 1 at or below their low-stock alert (min 0 = off; screens/04 AC 4). */
export async function lowStockCount(db: BikriDb): Promise<number> {
  let count = 0;
  const products = await db.products.toArray();
  for (const p of products) {
    const min = Number(p.min_stock_milli ?? 0);
    if (p.deleted_at || p.track_stock !== 1 || min <= 0) continue;
    const level = (await db.stock_levels.get(p.id))?.on_hand_milli ?? 0;
    if (level <= min) count += 1;
  }
  return count;
}

/** screens/04 attention list, at most 5 items, in the spec's order. */
export async function attentionItems(
  db: BikriDb,
  opts: {
    today: string;
    yesterday: string;
    deviceId: string;
    isOwner: boolean;
    now?: number;
  },
): Promise<AttentionItem[]> {
  const items: AttentionItem[] = [];
  const low = await lowStockCount(db);
  if (low > 0) items.push({ kind: 'low_stock', count: low });
  const promises = (await db.promises.toArray()).filter(
    (p) =>
      !p.deleted_at &&
      p.status === 'open' &&
      String(p.promised_on) === opts.today,
  ).length;
  if (promises > 0) items.push({ kind: 'promises_due', count: promises });
  let over = 0;
  for (const c of await db.customers.toArray()) {
    if (c.deleted_at || c.credit_limit === null || c.credit_limit === undefined)
      continue;
    const bal = (await db.party_balances.get(['customer', c.id]))?.balance ?? 0;
    if (bal > Number(c.credit_limit)) over += 1;
  }
  if (over > 0) items.push({ kind: 'over_limit', count: over });
  const failed = await db.print_jobs.where('status').equals('failed').count();
  if (failed > 0) items.push({ kind: 'failed_prints', count: failed });
  if (opts.isOwner) {
    const conflicts = await db.sync_conflicts.count();
    if (conflicts > 0) items.push({ kind: 'conflicts', count: conflicts });
  }
  const held = await heldExpiringCount(db, opts.now);
  if (held > 0) items.push({ kind: 'held_expiring', count: held });
  const soldYesterday = (
    await db.sales.where('business_date').equals(opts.yesterday).toArray()
  ).some((s) => s.device_id === opts.deviceId);
  const closedYesterday = (
    await db.day_closes.where('business_date').equals(opts.yesterday).toArray()
  ).some((d) => d.device_id === opts.deviceId);
  if (soldYesterday && !closedYesterday)
    items.push({ kind: 'day_not_closed', date: opts.yesterday });
  return items.slice(0, 5);
}

export type RecentBill = { sale: SyncedRow; methods: string[] };

/** Last 5 bills of this device, newest first, with their payment methods. */
export async function recentBills(
  db: BikriDb,
  deviceId: string,
  limit = 5,
): Promise<RecentBill[]> {
  const sales = (await db.sales.orderBy('created_at').reverse().toArray())
    .filter((s) => s.device_id === deviceId)
    .slice(0, limit);
  const out: RecentBill[] = [];
  for (const sale of sales) {
    const pays = await db.payments.where('sale_id').equals(sale.id).toArray();
    const methods = [
      ...new Set(
        pays.filter((p) => p.direction === 'in').map((p) => String(p.method)),
      ),
    ];
    if (Number(sale.udhaar_amount) > 0) methods.push('udhaar');
    out.push({ sale, methods });
  }
  return out;
}
