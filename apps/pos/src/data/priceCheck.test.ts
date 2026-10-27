import { afterEach, describe, expect, it } from 'vitest';
import { ledgerContext, saveNewProduct } from './catalog.ts';
import { priceCheck } from './priceCheck.ts';
import { dropTestDbs } from './testDb.ts';
import { NOW, readyDb } from './testShop.ts';

afterEach(dropTestDbs);

async function shop(
  prefix: string,
  name = 'Type-C cable 1 m',
  code = '8901111111111',
) {
  const db = await readyDb(prefix);
  const ctx = await ledgerContext(db, 'st-1');
  const cable = await saveNewProduct(
    db,
    {
      name_en: name,
      name_ur: 'ٹائپ سی کیبل',
      price: 45000,
      cost: 30000,
      opening_milli: 12000,
      barcodes: [code, '5550001'],
    },
    ctx,
    { now: NOW },
  );
  await saveNewProduct(
    db,
    { name_en: 'Type-C charger', price: 150000, track_stock: false },
    ctx,
    { now: NOW },
  );
  await saveNewProduct(db, { name_en: 'Micro USB cable', price: 20000 }, ctx, {
    now: NOW,
  });
  return { db, cable };
}

const counts = async (db: Awaited<ReturnType<typeof shop>>['db']) => ({
  outbox: await db.outbox.count(),
  audit: await db.audit_log.count(),
  movements: await db.stock_movements.count(),
  kv: await db.kv.count(),
});

describe('price check (screens/18)', () => {
  it('a barcode shows price, stock and every barcode', async () => {
    const { db, cable } = await shop('pc1');
    const r = await priceCheck(db, ' 8901111111111 ');
    expect(r).toMatchObject({
      kind: 'found',
      card: { product: { id: cable.id, price: 45000 }, onHandMilli: 12000 },
    });
    if (r.kind === 'found')
      expect(r.card.barcodes).toEqual(['5550001', '8901111111111']);
  });

  it('SKU or a single name match finds one; untracked stock is null; several names list', async () => {
    const { db, cable } = await shop('pc2');
    const sku = String(cable.sku);
    expect((await priceCheck(db, sku)).kind).toBe('found');
    const charger = await priceCheck(db, 'charger');
    expect(charger).toMatchObject({
      kind: 'found',
      card: { onHandMilli: null },
    });
    const urdu = await priceCheck(db, 'کیبل');
    expect(urdu).toMatchObject({
      kind: 'found',
      card: { product: { id: cable.id } },
    });
    const many = await priceCheck(db, 'cable');
    expect(many.kind).toBe('matches');
    if (many.kind === 'matches') {
      expect(many.products.map((p) => p.name_en)).toEqual([
        'Micro USB cable',
        'Type-C cable 1 m',
      ]);
    }
    expect((await priceCheck(db, '000000')).kind).toBe('none');
    expect((await priceCheck(db, '  ')).kind).toBe('none');
  });

  it('AC 2: nothing is written, no audit', async () => {
    const { db } = await shop('pc3');
    const before = await counts(db);
    await priceCheck(db, '8901111111111');
    await priceCheck(db, 'cable');
    await priceCheck(db, 'nothing');
    expect(await counts(db)).toEqual(before);
  });

  it('isolation: a shop never finds another shop’s product by barcode or name', async () => {
    const a = await shop('pc-a', 'Shop A cable', '8901111111111');
    const b = await shop('pc-b', 'Zinger cable', '8902222222222');
    expect((await priceCheck(a.db, '8902222222222')).kind).toBe('none');
    expect((await priceCheck(b.db, '8901111111111')).kind).toBe('none');
    expect((await priceCheck(a.db, 'Zinger')).kind).toBe('none');
    const own = await priceCheck(b.db, '8902222222222');
    expect(own).toMatchObject({
      kind: 'found',
      card: { product: { id: b.cable.id } },
    });
  });
});
