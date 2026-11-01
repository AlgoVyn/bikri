import { afterEach, describe, expect, it } from 'vitest';
import { searchAll } from './search.ts';
import { dropTestDbs } from './testDb.ts';
import { NOW, readyDb } from './testShop.ts';

afterEach(dropTestDbs);

const TODAY = '2026-11-02';
const YESTERDAY = '2026-11-01';

async function seeded() {
  const db = await readyDb('search');
  await db.products.bulkAdd([
    {
      id: 'p-charger',
      name_en: 'Fast Charger',
      name_ur: 'چارجڑ',
      brand: 'Anker',
      sku: 'CH-1',
      price: 100000,
      deleted_at: null,
    },
    {
      id: 'p-old',
      name_en: 'Old Charger',
      sku: 'CH-0',
      price: 100000,
      deleted_at: NOW,
    },
    {
      id: 'p-cable',
      name_en: 'Cable',
      sku: 'CB-1',
      price: 50000,
      deleted_at: null,
    },
    {
      id: 'p-noname',
      sku: 'NN-1',
      price: 0,
      deleted_at: null,
    },
    ...Array.from({ length: 6 }, (_, index) => ({
      id: `p-bulk-${index}`,
      name_en: `Bulk item ${index}`,
      sku: `BK-${index}`,
      price: 1000,
      deleted_at: null,
    })),
  ] as never);
  await db.product_barcodes.add({
    id: 'bc-cable',
    product_id: 'p-cable',
    barcode: '123456789012',
    deleted_at: null,
  } as never);
  await db.customers.bulkAdd([
    {
      id: 'c-ali',
      name: 'Ali Raza',
      phone: '+92 300 1234567',
      deleted_at: null,
    },
    {
      id: 'c-old',
      name: 'Ali Old',
      phone: '+92 300 0000000',
      deleted_at: NOW,
    },
    ...Array.from({ length: 5 }, (_, index) => ({
      id: `c-ali-${index}`,
      name: `Ali Friend ${index}`,
      phone: `+92 300 200000${index}`,
      deleted_at: null,
    })),
    { id: 'c-noname', deleted_at: null },
  ] as never);
  await db.sales.bulkAdd([
    {
      id: 's-today',
      invoice_no: 'A-A-1',
      business_date: TODAY,
      branch_id: 'br-1',
      created_at: NOW,
      total: 1000,
    },
    {
      id: 's-old',
      invoice_no: 'A-A-2',
      business_date: YESTERDAY,
      branch_id: 'br-2',
      created_at: NOW - 86_400_000,
      total: 1000,
    },
    {
      id: 's-nobranch',
      invoice_no: 'NB-1',
      business_date: TODAY,
      created_at: NOW - 1000,
      total: 1000,
    },
    ...Array.from({ length: 6 }, (_, index) => ({
      id: `s-bulk-${index}`,
      invoice_no: `BULK-${index}`,
      business_date: TODAY,
      branch_id: 'br-1',
      created_at: NOW - 2000 - index,
      total: 1000,
    })),
  ] as never);
  return db;
}

describe('searchAll (screens/04)', () => {
  it('ignores an empty query and deleted products/customers', async () => {
    const db = await seeded();
    expect(await searchAll(db, '   ')).toEqual([]);
    const charger = await searchAll(db, 'charger');
    expect(charger.filter((hit) => hit.kind === 'product')).toHaveLength(1);
    expect(charger[0]?.id).toBe('p-charger');
    const ali = (await searchAll(db, 'ali')).filter(
      (hit) => hit.kind === 'customer',
    );
    expect(ali).toHaveLength(5);
    expect(ali.map((hit) => hit.id)).toContain('c-ali');
    expect(ali.map((hit) => hit.id)).not.toContain('c-old');
  });

  it('finds a product by barcode and caps each group at five', async () => {
    const db = await seeded();
    expect((await searchAll(db, '123456789012')).map((hit) => hit.id)).toEqual([
      'p-cable',
    ]);
    const bulk = await searchAll(db, 'bulk');
    expect(bulk.filter((hit) => hit.kind === 'product')).toHaveLength(5);
    expect(bulk.filter((hit) => hit.kind === 'bill')).toHaveLength(5);
  });

  it('matches a phone by its last digits and skips short digit searches', async () => {
    const db = await seeded();
    expect((await searchAll(db, '0300 123')).map((hit) => hit.id)).toContain(
      'c-ali',
    );
    expect(await searchAll(db, '12')).toEqual([]);
    expect(await searchAll(db, '999')).toEqual([]);
  });

  it('scopes bills by date, branch or both for a cashier', async () => {
    const db = await seeded();
    const scope = { allDates: false, today: TODAY };
    expect((await searchAll(db, 'a-a-1', scope)).map((hit) => hit.id)).toEqual([
      's-today',
    ]);
    expect(await searchAll(db, 'a-a-2', scope)).toEqual([]);
    expect(
      (await searchAll(db, 'a-a-2', { ...scope, allDates: true })).map(
        (hit) => hit.id,
      ),
    ).toEqual(['s-old']);
    expect(
      await searchAll(db, 'a-a-2', {
        ...scope,
        allDates: true,
        branchId: 'br-1',
      }),
    ).toEqual([]);
    expect(
      (
        await searchAll(db, 'a-a-2', {
          ...scope,
          allDates: true,
          branchId: 'br-2',
        })
      ).map((hit) => hit.id),
    ).toEqual(['s-old']);
    // No scope at all: the invoice search still runs over every date.
    expect((await searchAll(db, 'a-a-2')).map((hit) => hit.id)).toEqual([
      's-old',
    ]);
  });
});
