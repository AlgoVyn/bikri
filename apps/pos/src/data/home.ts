import type { BikriDb, PartyType, SyncedRow } from '@bikri/db';
import { heldExpiringCount } from './cart.ts';
import { unresolvedFailedCount } from './printJobs.ts';

export type AttentionItem =
  | { kind: 'low_stock'; count: number }
  | { kind: 'promises_due'; count: number }
  | { kind: 'over_limit'; count: number }
  | { kind: 'failed_prints'; count: number }
  | { kind: 'conflicts'; count: number }
  | { kind: 'held_expiring'; count: number }
  | { kind: 'day_not_closed'; date: string }
  | { kind: 'sync_stale'; days: number; severe: boolean }
  | { kind: 'sync_pending_old'; since: number }
  | { kind: 'clock_wrong' };

const DAY = 86_400_000;
export const CLOCK_WARN_MS = 5 * 60_000;

/** Sync warnings for an enrolled till (03 §4.4, §6, §7; T-037). */
export async function syncAttention(
  db: BikriDb,
  now = Date.now(),
): Promise<AttentionItem[]> {
  const kv = async <T>(key: string) =>
    (await db.kv.get(key))?.value as T | undefined;
  if (!(await kv<string>('device_token'))) return [];
  const items: AttentionItem[] = [];
  const skew = (await kv<number>('clock_skew_ms')) ?? 0;
  if (Math.abs(skew) > CLOCK_WARN_MS) items.push({ kind: 'clock_wrong' });
  const last =
    (await kv<number>('last_sync_at')) ?? (await kv<number>('enrolled_at'));
  if (last !== undefined) {
    const days = Math.floor((now - last) / DAY);
    if (days >= 7) items.push({ kind: 'sync_stale', days, severe: days >= 25 });
  }
  const oldest = await db.outbox.where('status').equals('pending').first();
  if (oldest && now - oldest.created_at > DAY)
    items.push({ kind: 'sync_pending_old', since: oldest.created_at });
  return items;
}

/** Products with track_stock = 1 at or below their low-stock alert (min 0 = off; screens/04 AC 4). */
export async function lowStockCount(db: BikriDb): Promise<number> {
  let count = 0;
  const products = (await db.products.toArray()).filter(
    (p) =>
      !p.deleted_at &&
      p.track_stock === 1 &&
      Number(p.min_stock_milli ?? 0) > 0,
  );
  const levels = await db.stock_levels.bulkGet(products.map((p) => p.id));
  for (const [index, p] of products.entries()) {
    const level = levels[index]?.on_hand_milli ?? 0;
    if (level <= Number(p.min_stock_milli ?? 0)) count += 1;
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
  const items: AttentionItem[] = await syncAttention(db, opts.now);
  const low = await lowStockCount(db);
  if (low > 0) items.push({ kind: 'low_stock', count: low });
  const promises = (await db.promises.toArray()).filter(
    (p) =>
      !p.deleted_at &&
      p.status === 'open' &&
      String(p.promised_on) === opts.today,
  ).length;
  if (promises > 0) items.push({ kind: 'promises_due', count: promises });
  const customers = (await db.customers.toArray()).filter(
    (c) =>
      !c.deleted_at && c.credit_limit !== null && c.credit_limit !== undefined,
  );
  const balances = await db.party_balances.bulkGet(
    customers.map((c) => ['customer', c.id] as [PartyType, string]),
  );
  const over = balances.reduce(
    (count, balance, index) =>
      (balance?.balance ?? 0) > Number(customers[index]?.credit_limit ?? 0)
        ? count + 1
        : count,
    0,
  );
  if (over > 0) items.push({ kind: 'over_limit', count: over });
  const failed = await unresolvedFailedCount(db);
  if (failed > 0) items.push({ kind: 'failed_prints', count: failed });
  if (opts.isOwner) {
    const conflicts = (await db.sync_conflicts.toArray()).filter(
      (c) => c.resolution === 'needs_owner',
    ).length;
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

/** Last 5 bills of the shop, newest first, with their payment methods. */
export async function recentBills(
  db: BikriDb,
  limit = 5,
): Promise<RecentBill[]> {
  // Shop-wide, newest first. Fetch a small window from the created_at index,
  // then sort by the invoice sequence too: two tills (or two quick bills) can
  // share a timestamp, and the higher sequence is the later bill.
  const window = await db.sales
    .orderBy('created_at')
    .reverse()
    .limit(50)
    .toArray();
  const sales = window
    .sort(
      (a, b) =>
        Number(b.created_at) - Number(a.created_at) ||
        Number(b.invoice_seq) - Number(a.invoice_seq) ||
        String(b.id).localeCompare(String(a.id)),
    )
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

/** A small starter catalogue for a brand-new shop (Home onboarding, D-151). */
export async function addSampleProducts(
  db: BikriDb,
  staffId: string,
): Promise<number> {
  const { ledgerContext, saveNewProduct } = await import('./catalog.ts');
  const ctx = await ledgerContext(db, staffId);
  const samples = [
    { name_en: 'USB-C cable 1 m', price: 49900, cost: 22000, stock: 40 },
    { name_en: 'Phone cover', price: 39900, cost: 15000, stock: 30 },
    { name_en: 'Tempered glass', price: 24900, cost: 9000, stock: 25 },
    { name_en: 'Fast charger 25 W', price: 129900, cost: 88000, stock: 18 },
    { name_en: 'Wireless earbuds', price: 349900, cost: 260000, stock: 10 },
    { name_en: 'Power bank 10,000 mAh', price: 449900, cost: 350000, stock: 8 },
    { name_en: 'Car mount', price: 89900, cost: 52000, stock: 12 },
    { name_en: 'Bluetooth speaker', price: 289900, cost: 210000, stock: 6 },
  ];
  for (const sample of samples) {
    await saveNewProduct(
      db,
      {
        name_en: sample.name_en,
        price: sample.price,
        cost: sample.cost,
        opening_milli: sample.stock * 1000,
        track_stock: true,
        min_stock_milli: 2000,
      },
      ctx,
    );
  }
  return samples.length;
}
