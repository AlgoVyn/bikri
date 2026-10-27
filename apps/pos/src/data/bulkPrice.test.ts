import { afterEach, describe, expect, it } from 'vitest';
import {
  applyPrices,
  newPrice,
  PRICE_CHUNK,
  pricePreview,
} from './bulkPrice.ts';
import { addCategory, ledgerContext, saveNewProduct } from './catalog.ts';
import { dropTestDbs } from './testDb.ts';
import { NOW, readyDb } from './testShop.ts';

afterEach(dropTestDbs);

describe('update prices (bulk)', () => {
  it('AC 6: +10% with Rs 10 rounding turns Rs 1,499 into Rs 1,650', () => {
    expect(newPrice(149900, { kind: 'percent', bp: 1000 }, 1000)).toBe(165000);
    expect(newPrice(149900, { kind: 'percent', bp: 1000 }, 0)).toBe(164890);
    expect(newPrice(149900, { kind: 'percent', bp: -500 }, 500)).toBe(142500);
    expect(newPrice(149900, { kind: 'amount', paisa: -10000 }, 100)).toBe(
      139900,
    );
    expect(newPrice(5000, { kind: 'amount', paisa: -10000 }, 0)).toBe(0);
    expect(newPrice(149900, { kind: 'set', paisa: 120000 }, 1000)).toBe(120000);
    expect(newPrice(149500, { kind: 'percent', bp: 0 }, 1000)).toBe(150000);
  });

  it('filters by category, brand or selection; applies with one audit per changed product', async () => {
    const db = await readyDb('bp1');
    const ctx = await ledgerContext(db, 'st-1');
    const cables = await addCategory(db, 'Cables', 't1', { now: NOW });
    const a = await saveNewProduct(
      db,
      {
        name_en: 'A cable',
        price: 149900,
        category_id: cables.id,
        brand: 'Anker',
      },
      ctx,
      { now: NOW },
    );
    const b = await saveNewProduct(
      db,
      { name_en: 'B cable', price: 100000, category_id: cables.id },
      ctx,
      { now: NOW },
    );
    const c = await saveNewProduct(
      db,
      { name_en: 'Charger', price: 150000, brand: 'anker' },
      ctx,
      { now: NOW },
    );
    const pct = { kind: 'percent', bp: 1000 } as const;
    expect(
      (await pricePreview(db, { categoryId: cables.id }, pct, 1000)).map(
        (r) => r.product.id,
      ),
    ).toEqual([a.id, b.id]);
    expect(
      (await pricePreview(db, { brand: 'ANKER' }, pct, 1000)).map(
        (r) => r.product.id,
      ),
    ).toEqual([a.id, c.id]);
    expect(
      (await pricePreview(db, { ids: [c.id] }, pct, 1000)).map(
        (r) => r.product.id,
      ),
    ).toEqual([c.id]);
    const rows = await pricePreview(db, {}, { kind: 'set', paisa: 100000 }, 0);
    expect(await applyPrices(db, rows, ctx, { now: NOW + 1 })).toBe(2);
    expect((await db.products.toArray()).map((p) => p.price)).toEqual([
      100000, 100000, 100000,
    ]);
    const audit = await db.audit_log

      .filter((r) => r.action === 'price_change')
      .toArray();
    expect(audit.map((r) => r.entity_id).sort()).toEqual([a.id, c.id].sort());
  });

  it('chunks of 100 products per action', async () => {
    const db = await readyDb('bp2');
    const ctx = await ledgerContext(db, 'st-1');
    for (let i = 0; i < 150; i += 1)
      await saveNewProduct(db, { name_en: `P${i}`, price: 1000 }, ctx, {
        now: NOW,
      });
    const before = new Set((await db.outbox.toArray()).map((o) => o.tx_id));
    await applyPrices(
      db,
      await pricePreview(db, {}, { kind: 'amount', paisa: 100 }, 0),
      ctx,
      { now: NOW + 1 },
    );
    const txs = new Map<string, number>();
    for (const o of await db.outbox.toArray()) {
      if (before.has(o.tx_id)) continue;
      txs.set(String(o.tx_id), (txs.get(String(o.tx_id)) ?? 0) + 1);
    }
    expect([...txs.values()]).toEqual([PRICE_CHUNK, 50]);
  });

  it('isolation: one shop’s bulk update never changes another shop', async () => {
    const a = await readyDb('bp-a');
    const b = await readyDb('bp-b');
    const ca = await ledgerContext(a, 'st-1');
    const cb = await ledgerContext(b, 'st-1');
    await saveNewProduct(a, { name_en: 'Cable', price: 100000 }, ca, {
      now: NOW,
    });
    const pb = await saveNewProduct(
      b,
      { name_en: 'Cable', price: 100000 },
      cb,
      { now: NOW },
    );
    await applyPrices(
      a,
      await pricePreview(a, {}, { kind: 'percent', bp: 1000 }, 0),
      ca,
      { now: NOW + 1 },
    );
    expect((await b.products.get(pb.id))?.price).toBe(100000);
    expect(await b.audit_log.count()).toBe(0);
  });
});
