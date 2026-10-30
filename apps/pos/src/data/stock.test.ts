import type { MasterRow } from '@bikri/db';
import { afterEach, describe, expect, it } from 'vitest';
import { ledgerContext, saveNewProduct } from './catalog.ts';
import {
  adjustDelta,
  adjustStock,
  countProducts,
  discardCount,
  finishCount,
  loadCountDraft,
  needsCost,
  needsNote,
  onHand,
  StockAdjustError,
  saveCountDraft,
  startCount,
  updateCount,
} from './stock.ts';
import { dropTestDbs } from './testDb.ts';
import { NOW, readyDb } from './testShop.ts';

afterEach(dropTestDbs);

async function shop(prefix = 'stk', opening = 12000, cost = 110000) {
  const db = await readyDb(prefix);
  const ctx = await ledgerContext(db, 'st-1');
  const p = await saveNewProduct(
    db,
    { name_en: 'Cable', price: 150000, cost, opening_milli: opening },
    ctx,
    { now: NOW },
  );
  return { db, ctx, p };
}

const movements = (
  db: Awaited<ReturnType<typeof shop>>['db'],
  reason: string,
) => db.stock_movements.filter((m) => m.reason_code === reason).toArray();

describe('stock adjust (screens/09)', () => {
  it('AC 1: stock out 3 Damaged on 12 gives 9 and a damaged movement of −3000', async () => {
    const { db, ctx, p } = await shop();
    await db.outbox.clear();
    const m = await adjustStock(
      db,
      { productId: p.id, kind: 'out', reason: 'damaged', qtyMilli: 3000 },
      ctx,
      NOW,
    );
    expect(m).toMatchObject({
      qty_delta_milli: -3000,
      reason_code: 'damaged',
      ref_type: 'adjustment',
      unit_cost: null,
    });
    expect(await onHand(db, p.id)).toBe(9000);
    const ops = await db.outbox
      .filter((o) => o.tbl === 'stock_movements')
      .count();
    expect(ops).toBe(1);
  });

  it('AC 2: count 10 on 12 writes count −2000; count equal to on hand writes nothing', async () => {
    const { db, ctx, p } = await shop();
    await adjustStock(
      db,
      { productId: p.id, kind: 'count', qtyMilli: 10000 },
      ctx,
      NOW,
    );
    expect(
      (await movements(db, 'count')).map((m) => m.qty_delta_milli),
    ).toEqual([-2000]);
    expect(
      await adjustStock(
        db,
        { productId: p.id, kind: 'count', qtyMilli: 10000 },
        ctx,
        NOW,
      ),
    ).toBeNull();
    expect(await movements(db, 'count')).toHaveLength(1);
  });

  it('AC 3 (C1): stock in 5 Bought locally @ 1,200 on 20 @ 1,100 → avg 1,120; last cost 1,200', async () => {
    const { db, ctx, p } = await shop('stkC1', 20000, 110000);
    await adjustStock(
      db,
      {
        productId: p.id,
        kind: 'in',
        reason: 'received_local',
        qtyMilli: 5000,
        unitCost: 120000,
      },
      ctx,
      NOW,
    );
    const after = (await db.products.get(p.id)) as MasterRow;
    expect(after.avg_cost).toBe(112000);
    expect(after.last_cost).toBe(120000);
    expect(await onHand(db, p.id)).toBe(25000);
    // customer return has no cost and keeps the average
    await adjustStock(
      db,
      {
        productId: p.id,
        kind: 'in',
        reason: 'customer_return',
        qtyMilli: 1000,
      },
      ctx,
      NOW,
    );
    expect(((await db.products.get(p.id)) as MasterRow).avg_cost).toBe(112000);
  });

  it('C2: negative on hand resets the average to the new cost', async () => {
    const { db, ctx, p } = await shop('stkC2', 1000, 100000);
    await adjustStock(
      db,
      {
        productId: p.id,
        kind: 'out',
        reason: 'lost',
        qtyMilli: 3000,
        note: 'shop lifting',
      },
      ctx,
      NOW,
    );
    await adjustStock(
      db,
      {
        productId: p.id,
        kind: 'in',
        reason: 'received_godown',
        qtyMilli: 10000,
        unitCost: 95000,
      },
      ctx,
      NOW,
    );
    expect(((await db.products.get(p.id)) as MasterRow).avg_cost).toBe(95000);
  });

  it('validates qty, cost, note and product; fix entry is signed', async () => {
    const { db, ctx, p } = await shop();
    const bad = (input: Parameters<typeof adjustStock>[1]) =>
      adjustStock(db, input, ctx, NOW);
    await expect(
      bad({ productId: p.id, kind: 'out', reason: 'damaged', qtyMilli: 0 }),
    ).rejects.toMatchObject({ field: 'qty' });
    await expect(
      bad({
        productId: p.id,
        kind: 'in',
        reason: 'received_local',
        qtyMilli: 1000,
      }),
    ).rejects.toMatchObject({ field: 'cost' });
    await expect(
      bad({ productId: p.id, kind: 'out', reason: 'lost', qtyMilli: 1000 }),
    ).rejects.toMatchObject({ field: 'note' });
    await expect(
      bad({ productId: p.id, kind: 'fix', qtyMilli: 1000 }),
    ).rejects.toMatchObject({ field: 'note' });
    await expect(
      bad({ productId: p.id, kind: 'fix', qtyMilli: 0, note: 'x' }),
    ).rejects.toBeInstanceOf(StockAdjustError);
    await expect(
      bad({ productId: p.id, kind: 'count', qtyMilli: -1 }),
    ).rejects.toMatchObject({ field: 'qty' });
    await expect(
      bad({
        productId: p.id,
        kind: 'out',
        reason: 'received_local' as never,
        qtyMilli: 1,
      }),
    ).rejects.toBeInstanceOf(StockAdjustError);
    await expect(
      bad({
        productId: p.id,
        kind: 'out',
        reason: 'damaged',
        qtyMilli: 1,
        note: 'x'.repeat(121),
      }),
    ).rejects.toMatchObject({ field: 'note' });
    await expect(
      bad({ productId: 'nope', kind: 'out', reason: 'damaged', qtyMilli: 1 }),
    ).rejects.toMatchObject({ field: 'product' });
    await bad({
      productId: p.id,
      kind: 'fix',
      qtyMilli: -500,
      note: 'typo in last adjust',
    });
    expect(await onHand(db, p.id)).toBe(11500);
    expect(adjustDelta('count', 3000, 5000)).toBe(-2000);
    expect(needsCost('received_other')).toBe(true);
    expect(needsNote('damaged')).toBe(false);
  });

  it('AC 4: movements from two tills both apply (on hand is the sum)', async () => {
    const { db, ctx, p } = await shop();
    await adjustStock(
      db,
      { productId: p.id, kind: 'out', reason: 'damaged', qtyMilli: 2000 },
      ctx,
      NOW,
    );
    // a sale movement arriving from another till (pulled) counts too
    const other = { ...ctx, device_id: 'dev-2' };
    await adjustStock(
      db,
      { productId: p.id, kind: 'out', reason: 'expired', qtyMilli: 1000 },
      other,
      NOW + 1,
    );
    expect(await onHand(db, p.id)).toBe(9000);
  });
});

describe('stock count (screens/09)', () => {
  it('uses on hand at Finish, skips uncounted unless zeroed, audits totals, clears the draft', async () => {
    const { db, ctx, p } = await shop('cnt');
    const q = await saveNewProduct(
      db,
      {
        name_en: 'Adapter',
        price: 50000,
        cost: 30000,
        opening_milli: 4000,
        min_stock_milli: 5000,
      },
      ctx,
      { now: NOW },
    );
    await saveNewProduct(
      db,
      { name_en: 'Service', price: 1000, track_stock: false },
      ctx,
      { now: NOW },
    );
    expect(
      (await countProducts(db, { kind: 'all' })).map((x) => x.name_en),
    ).toEqual(['Adapter', 'Cable']);
    expect(
      (await countProducts(db, { kind: 'low' })).map((x) => x.name_en),
    ).toEqual(['Adapter']);
    const draft = await startCount(db, { kind: 'all' }, NOW);
    expect(draft.expected).toEqual({ [p.id]: 12000, [q.id]: 4000 });
    draft.counted[p.id] = 10000;
    await saveCountDraft(db, draft);
    expect(await loadCountDraft(db)).toMatchObject({
      counted: { [p.id]: 10000 },
    });
    // a sale during the count: on hand 12 → 11; counted 10 → movement −1000
    await adjustStock(
      db,
      { productId: p.id, kind: 'out', reason: 'damaged', qtyMilli: 1000 },
      ctx,
      NOW,
    );
    const r = await finishCount(db, draft, { zeroUncounted: false }, ctx, NOW);
    expect(r).toEqual({ movements: 1, counted: 1, valueDiff: -110000 });
    expect(
      (await movements(db, 'count')).map((m) => m.qty_delta_milli),
    ).toEqual([-1000]);
    expect(await onHand(db, q.id)).toBe(4000);
    expect(await loadCountDraft(db)).toBeNull();
    const audit = (await db.audit_log.toArray()).filter(
      (a) => a.action === 'stock_count',
    );
    expect(JSON.parse(String(audit[0]?.after_json))).toMatchObject({
      items_counted: 1,
      movements: 1,
      value_diff: -110000,
    });
    // set uncounted to 0
    const again = await startCount(
      db,
      { kind: 'category', categoryId: 'none' },
      NOW,
    );
    expect(again.expected).toEqual({});
    const all = await startCount(db, { kind: 'all' }, NOW);
    await finishCount(db, all, { zeroUncounted: true }, ctx, NOW);
    expect(await onHand(db, q.id)).toBe(0);
    expect(await onHand(db, p.id)).toBe(0);
    await discardCount(db);
  });

  it('skips chunks already applied before a partial count retry', async () => {
    const { db, ctx, p } = await shop('stk-applied');
    const draft = await startCount(db, { kind: 'all' }, NOW);
    draft.counted[p.id] = 9000;
    draft.applied = [p.id];
    const r = await finishCount(db, draft, { zeroUncounted: false }, ctx, NOW);
    expect(r).toEqual({ movements: 0, counted: 0, valueDiff: 0 });
    expect(await onHand(db, p.id)).toBe(12000);
  });

  it('isolation: adjustments and counts stay in their own shop', async () => {
    const a = await shop('stkA');
    const b = await shop('stkB');
    await adjustStock(
      a.db,
      { productId: a.p.id, kind: 'out', reason: 'damaged', qtyMilli: 3000 },
      a.ctx,
      NOW,
    );
    await expect(
      adjustStock(
        b.db,
        { productId: a.p.id, kind: 'out', reason: 'damaged', qtyMilli: 1000 },
        b.ctx,
        NOW,
      ),
    ).rejects.toMatchObject({ field: 'product' });
    expect(await onHand(b.db, b.p.id)).toBe(12000);
    const draftA = await startCount(a.db, { kind: 'all' }, NOW);
    expect(await loadCountDraft(b.db)).toBeNull();
    draftA.counted[b.p.id] = 0; // foreign id in a draft is ignored (not in expected)
    await finishCount(a.db, draftA, { zeroUncounted: false }, a.ctx, NOW);
    expect(
      await b.db.stock_movements
        .filter((m) => m.reason_code === 'count')
        .count(),
    ).toBe(0);
  });
});

describe('count draft updates', () => {
  it('rapid +1 updates are serialised and none is lost', async () => {
    const { db, p } = await shop('stk-race');
    await startCount(db, { kind: 'all' }, NOW);
    await Promise.all(
      Array.from({ length: 5 }, () =>
        updateCount(db, p.id, (c) => (c ?? 0) + 1000),
      ),
    );
    expect((await loadCountDraft(db))?.counted[p.id]).toBe(5000);
  });
});
