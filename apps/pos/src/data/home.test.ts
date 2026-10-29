import { afterEach, describe, expect, it } from 'vitest';
import { attentionItems, lowStockCount } from './home.ts';
import { dropTestDbs } from './testDb.ts';
import { NOW, readyDb } from './testShop.ts';

afterEach(dropTestDbs);

describe('home attention data', () => {
  it('bulk-reads stock levels and ignores untracked, deleted or unlimited products', async () => {
    const db = await readyDb('home-low');
    const row = { created_at: NOW, updated_at: NOW, deleted_at: null, rev: 1 };
    await db.products.bulkAdd([
      {
        id: 'low',
        ...row,
        name_en: 'Low',
        min_stock_milli: 5000,
        track_stock: 1,
      },
      {
        id: 'fine',
        ...row,
        name_en: 'Fine',
        min_stock_milli: 5000,
        track_stock: 1,
      },
      {
        id: 'untracked',
        ...row,
        name_en: 'Service',
        min_stock_milli: 5000,
        track_stock: 0,
      },
      {
        id: 'deleted',
        ...row,
        name_en: 'Gone',
        min_stock_milli: 5000,
        track_stock: 1,
        deleted_at: 1,
      },
      {
        id: 'unlimited',
        ...row,
        name_en: 'No alert',
        min_stock_milli: 0,
        track_stock: 1,
      },
    ]);
    await db.stock_levels.bulkPut([
      { product_id: 'low', on_hand_milli: 1000 },
      { product_id: 'fine', on_hand_milli: 9000 },
      { product_id: 'untracked', on_hand_milli: 0 },
      { product_id: 'deleted', on_hand_milli: 0 },
      { product_id: 'unlimited', on_hand_milli: 0 },
    ]);
    expect(await lowStockCount(db)).toBe(1);
  });

  it('reports low stock and over-limit customers from bulk reads', async () => {
    const db = await readyDb('home-attention');
    await db.customers.add({
      id: 'c-over',
      name: 'Over',
      credit_limit: 1000,
      created_at: NOW,
      updated_at: NOW,
      deleted_at: null,
      rev: 1,
    });
    await db.party_balances.put({
      party_type: 'customer',
      party_id: 'c-over',
      balance: 2000,
      last_activity_at: NOW,
      oldest_unpaid_at: NOW,
    });
    await db.products.add({
      id: 'p-low',
      name_en: 'Low',
      min_stock_milli: 5000,
      track_stock: 1,
      created_at: NOW,
      updated_at: NOW,
      deleted_at: null,
      rev: 1,
    });
    await db.stock_levels.put({ product_id: 'p-low', on_hand_milli: 1000 });
    const items = await attentionItems(db, {
      today: '2026-10-27',
      yesterday: '2026-10-26',
      deviceId: 'dev-1',
      isOwner: false,
      now: NOW,
    });
    expect(items).toContainEqual({ kind: 'low_stock', count: 1 });
    expect(items).toContainEqual({ kind: 'over_limit', count: 1 });
  });
});
