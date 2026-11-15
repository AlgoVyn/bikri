import type { MasterRow } from '@bikri/db';
import { afterEach, describe, expect, it } from 'vitest';
import { rowsAnyOf } from './bulk.ts';
import { dropTestDbs } from './testDb.ts';
import { readyDb } from './testShop.ts';

afterEach(dropTestDbs);

describe('rowsAnyOf', () => {
  it('returns empty for no ids', async () => {
    const db = await readyDb('bulk-empty');
    expect(
      await rowsAnyOf<MasterRow>(db.products, 'id', [], (row) => row.id),
    ).toEqual([]);
  });

  it('chunks small id sets and scans larger ones', async () => {
    const db = await readyDb('bulk-rows');
    await db.products.bulkAdd(
      Array.from({ length: 250 }, (_, i) => ({
        id: `p-${i}`,
        name_en: `P ${i}`,
        sku: `SKU-${i}`,
        deleted_at: null,
      })) as never,
    );
    const small = await rowsAnyOf<MasterRow>(
      db.products,
      'id',
      ['p-1', 'p-2'],
      (r) => r.id,
    );
    expect(small.map((row) => row.id).sort()).toEqual(['p-1', 'p-2']);
    const large = await rowsAnyOf<MasterRow>(
      db.products,
      'id',
      Array.from({ length: 201 }, (_, i) => `p-${i}`),
      (r) => r.id,
    );
    expect(large).toHaveLength(201);
  });
});
