import { newId } from '@bikri/core';
import { describe, expect, it } from 'vitest';
import { IDS, seedShop } from './helpers/fixtures.ts';
import { op, productRow, pushOk, saleOps } from './helpers/ops.ts';

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

  it('rejects catalogue edits and soft deletes from a cashier', async () => {
    const shop = await seedShop('Catalogue perms');
    const now = Date.now();
    const res = await pushOk(shop.admin, [
      op(
        'products',
        'upsert',
        productRow(IDS.product, {
          name_en: 'Renamed by cashier',
          updated_by: IDS.cashier,
        }),
      ),
      op('categories', 'upsert', {
        id: '01JC00000000000000000000C9',
        name_en: 'Pwned',
        created_at: now,
        updated_at: now,
        updated_by: IDS.cashier,
      }),
      op('product_barcodes', 'upsert', {
        id: '01JC00000000000000000000B9',
        product_id: IDS.product,
        barcode: '9999999999999',
        created_at: now,
        updated_at: now,
        updated_by: IDS.cashier,
      }),
    ]);
    expect(res.results.map((r) => r.error_code)).toEqual([
      'FORBIDDEN',
      'FORBIDDEN',
      'FORBIDDEN',
    ]);
  });

  it('does not let a cashier mint an owner in the same transaction', async () => {
    const shop = await seedShop('Owner mint');
    const owner = newId();
    const res = await pushOk(shop.admin, [
      op('staff', 'upsert', {
        id: owner,
        name: 'Injected owner',
        role: 'owner',
        pin_hash: 'x',
        pin_salt: 'y',
        pin_iterations: 1,
        active: 1,
        created_at: Date.now(),
        updated_at: Date.now(),
        updated_by: owner,
      }),
    ]);
    expect(res.results[0]).toMatchObject({
      result: 'rejected',
      error_code: 'FORBIDDEN',
    });
  });

  it('rejects server-only or malformed audit rows from a till', async () => {
    const shop = await seedShop('Audit guard');
    const now = Date.now();
    const base = {
      entity: 'shop',
      entity_id: 'shop',
      before_json: null,
      device_id: shop.admin.id,
      staff_id: IDS.owner,
      created_at: now,
    };
    const res = await pushOk(shop.admin, [
      op('audit_log', 'insert', {
        ...base,
        id: newId(),
        action: 'tenant_status_change',
        after_json: '{}',
      }),
      op('audit_log', 'insert', {
        ...base,
        id: newId(),
        action: 'shop_change',
        after_json: '{oops',
      }),
    ]);
    expect(res.results.map((r) => r.error_code)).toEqual([
      'FORBIDDEN',
      'CONSTRAINT_FAILED',
    ]);
  });

  it('rejects a sale with no lines and accepts an older bill prefix', async () => {
    const shop = await seedShop('Sale shape');
    const [emptySale] = saleOps(shop, shop.till, 1);
    const empty = await pushOk(shop.till, emptySale ? [emptySale] : []);
    expect(empty.results[0]).toMatchObject({
      result: 'rejected',
      error_code: 'CONSTRAINT_FAILED',
    });
    const oldPrefix = await pushOk(
      shop.till,
      saleOps(shop, shop.till, 2, { prefix: 'OLD' }),
    );
    expect(oldPrefix.results.map((r) => r.result)).toEqual([
      'applied',
      'applied',
    ]);
  });
});
