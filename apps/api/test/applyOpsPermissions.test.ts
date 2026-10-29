import { describe, expect, it } from 'vitest';
import { IDS, seedShop } from './helpers/fixtures.ts';
import { op, pushOk } from './helpers/ops.ts';

describe('derived-ledger permissions (05 §5, 07 §5)', () => {
  it('refuses a cashier ledger adjustment and stock count', async () => {
    const shop = await seedShop('Ledger perms');
    const now = Date.now();
    const base = {
      branch_id: shop.branchId,
      device_id: shop.admin.id,
      staff_id: IDS.cashier,
      business_date: '2026-10-29',
      created_at: now,
    };
    const res = await pushOk(shop.admin, [
      op('ledger_entries', 'insert', {
        ...base,
        id: '01JC00000000000000000000L1',
        party_type: 'customer',
        party_id: '01JC00000000000000000000C1',
        amount: -1000,
        source_type: 'adjustment',
        source_id: null,
        note: '',
      }),
      op('stock_movements', 'insert', {
        ...base,
        id: '01JC00000000000000000000S1',
        product_id: IDS.product,
        qty_delta_milli: 5000,
        reason_code: 'count',
        ref_type: 'adjustment',
        ref_id: null,
        unit_cost: null,
        note: '',
      }),
    ]);
    expect(res.results.map((r) => [r.result, r.error_code])).toEqual([
      ['rejected', 'FORBIDDEN'],
      ['rejected', 'FORBIDDEN'],
    ]);
  });

  it('rejects oversized or non-finite row values', async () => {
    const shop = await seedShop('Row caps');
    const bad = await pushOk(shop.admin, [
      op('products', 'upsert', {
        ...{
          id: '01JC00000000000000000000P1',
          name_en: 'Capped',
          sku: 'CAP-1',
          price: 1000,
          notes: 'x'.repeat(4001),
          created_at: Date.now(),
          updated_at: Date.now(),
          updated_by: IDS.owner,
        },
      }),
    ]);
    expect(bad.results[0]).toMatchObject({
      result: 'rejected',
      error_code: 'CONSTRAINT_FAILED',
    });
  });

  it('accepts an owner stock count and rejects a movement without its source document', async () => {
    const shop = await seedShop('Ledger source');
    const now = Date.now();
    const base = {
      branch_id: shop.branchId,
      device_id: shop.admin.id,
      staff_id: IDS.owner,
      business_date: '2026-10-29',
      created_at: now,
    };
    const good = await pushOk(shop.admin, [
      op('stock_movements', 'insert', {
        ...base,
        id: '01JC00000000000000000000S2',
        product_id: IDS.product,
        qty_delta_milli: 1000,
        reason_code: 'count',
        ref_type: 'adjustment',
        ref_id: null,
        unit_cost: null,
        note: '',
      }),
    ]);
    expect(good.results[0]?.result).toBe('applied');

    const bad = await pushOk(shop.admin, [
      op('stock_movements', 'insert', {
        ...base,
        id: '01JC00000000000000000000S3',
        product_id: IDS.product,
        qty_delta_milli: -1000,
        reason_code: 'sale',
        ref_type: 'sale',
        ref_id: '01JC00000000000000000000X1',
        unit_cost: null,
        note: '',
      }),
    ]);
    expect(bad.results[0]).toMatchObject({
      result: 'rejected',
      error_code: 'CONSTRAINT_FAILED',
    });
  });
});
