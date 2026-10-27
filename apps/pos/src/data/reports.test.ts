import type { BikriDb } from '@bikri/db';
import { afterEach, describe, expect, it } from 'vitest';
import { seedSampleDay } from '../dev/sampleDay.ts';
import { attentionItems, lowStockCount, recentBills } from './home.ts';
import { expectedCash, summary } from './reports.ts';
import { dropTestDbs, freshDb } from './testDb.ts';
import { writeAction } from './write.ts';

afterEach(dropTestDbs);

const NOW = Date.UTC(2026, 9, 27, 9, 0);
const row = { created_at: NOW, updated_at: NOW, deleted_at: null, rev: 1 };

async function readyDb(prefix = 'rep', deviceId = 'dev-1'): Promise<BikriDb> {
  const db = freshDb(prefix);
  await db.branches.add({
    id: 'br-1',
    name: 'Main',
    bill_prefix: 'A',
    is_default: 1,
    ...row,
  });
  await db.staff.add({
    id: 'st-1',
    name: 'Adnan',
    role: 'owner',
    active: 1,
    permissions_json: '{}',
    ...row,
  });
  await db.expense_categories.add({
    id: 'ec-1',
    code: 'rent',
    name: 'Rent',
    sort_order: 1,
    ...row,
  });
  await db.kv.put({
    key: 'device',
    value: {
      id: deviceId,
      name: 'Counter 1',
      code: 'A',
      branch_id: 'br-1',
      is_admin: true,
    },
  });
  return db;
}

describe('Today figures (07 §9, screens/04 AC 1)', () => {
  it('nets refunds on their own date and computes profit and udhaar', async () => {
    const db = await readyDb();
    await seedSampleDay(db, '2026-10-27', NOW);
    const day = { from: '2026-10-27', to: '2026-10-27' };
    expect(await summary(db, day)).toEqual({
      sold: 100000,
      bills: 2,
      grossProfit: 40000,
      udhaarGiven: 30000,
      udhaarReceived: 10000,
    });
    expect(await summary(db, { ...day, deviceId: 'other' })).toMatchObject({
      sold: 0,
      bills: 0,
    });
    expect(
      await summary(db, { from: '2026-10-26', to: '2026-10-26' }),
    ).toMatchObject({ sold: 0 });
  });

  it('skips voided bills', async () => {
    const db = await readyDb();
    await seedSampleDay(db, '2026-10-27', NOW);
    const first = await db.sales
      .where('invoice_seq')
      .equals(2)
      .first()
      .catch(() => undefined);
    const sales = await db.sales.toArray();
    const target = first ?? sales.find((s) => s.invoice_seq === 2);
    if (!target) throw new Error('missing');
    await db.sales.update(target.id, { status: 'void' });
    expect(
      await summary(db, { from: '2026-10-27', to: '2026-10-27' }),
    ).toMatchObject({
      sold: 50000,
      bills: 1,
      udhaarGiven: 0,
    });
  });

  it("works out the drawer's expected cash since the last close (07 §8)", async () => {
    const db = await readyDb();
    await seedSampleDay(db, '2026-10-27', NOW);
    expect(await expectedCash(db, 'dev-1', NOW + 10)).toBe(75000);
    expect(await expectedCash(db, 'other', NOW + 10)).toBe(0);
    await db.day_closes.add({
      id: 'dc-1',
      device_id: 'dev-1',
      branch_id: 'br-1',
      business_date: '2026-10-27',
      period_start: 0,
      period_end: NOW + 5,
      counted_cash: 74000,
      created_at: NOW + 5,
    });
    expect(await expectedCash(db, 'dev-1', NOW + 10)).toBe(74000);
  });
});

describe('Home attention and recent bills (screens/04)', () => {
  it('counts low stock only for products that track stock (AC 4)', async () => {
    const db = await readyDb();
    await writeAction(db, async (w) => {
      await w.create('products', {
        name: 'Tracked',
        track_stock: 1,
        min_stock_milli: 2000,
      });
      await w.create('products', {
        name: 'Service',
        track_stock: 0,
        min_stock_milli: 2000,
      });
    });
    expect(await lowStockCount(db)).toBe(1);
    const items = await attentionItems(db, {
      today: '2026-10-27',
      yesterday: '2026-10-26',
      deviceId: 'dev-1',
      isOwner: true,
    });
    expect(items).toEqual([{ kind: 'low_stock', count: 1 }]);
  });

  it('flags an unclosed yesterday, failed prints, due promises, over-limit customers and conflicts for owners', async () => {
    const db = await readyDb();
    await seedSampleDay(db, '2026-10-26', NOW);
    const customer = (await db.customers.toArray())[0];
    if (!customer) throw new Error('missing');
    await db.customers.update(customer.id, { credit_limit: 10000 });
    await db.promises.add({
      id: 'p1',
      customer_id: customer.id,
      status: 'open',
      promised_on: '2026-10-27',
      ...row,
    });
    await db.print_jobs.add({
      id: 'pj1',
      status: 'failed',
      created_at: NOW,
    } as never);
    await db.sync_conflicts.add({ id: 'c1', row_id: 'x', at: NOW });
    const opts = {
      today: '2026-10-27',
      yesterday: '2026-10-26',
      deviceId: 'dev-1',
    };
    const kinds = (await attentionItems(db, { ...opts, isOwner: true })).map(
      (i) => i.kind,
    );
    expect(kinds).toEqual([
      'promises_due',
      'over_limit',
      'failed_prints',
      'conflicts',
      'day_not_closed',
    ]);
    const cashier = (await attentionItems(db, { ...opts, isOwner: false })).map(
      (i) => i.kind,
    );
    expect(cashier).not.toContain('conflicts');
  });

  it("lists this device's last bills, newest first, with their methods", async () => {
    const db = await readyDb();
    await seedSampleDay(db, '2026-10-27', NOW);
    const bills = await recentBills(db, 'dev-1');
    expect(bills.map((b) => [b.sale.invoice_no, b.methods])).toEqual([
      ['A-A-2', ['cash', 'udhaar']],
      ['A-A-1', ['cash']],
    ]);
    expect(await recentBills(db, 'other')).toEqual([]);
  });
});

describe('two shops on one till (I-till)', () => {
  it("keeps each shop's Today figures in its own database", async () => {
    const a = await readyDb('shop-a');
    const b = await readyDb('shop-b');
    await seedSampleDay(a, '2026-10-27', NOW);
    const day = { from: '2026-10-27', to: '2026-10-27' };
    expect((await summary(a, day)).sold).toBe(100000);
    expect(await summary(b, day)).toEqual({
      sold: 0,
      bills: 0,
      grossProfit: 0,
      udhaarGiven: 0,
      udhaarReceived: 0,
    });
    expect(await recentBills(b, 'dev-1')).toEqual([]);
    expect(await expectedCash(b, 'dev-1', NOW + 10)).toBe(0);
  });
});
