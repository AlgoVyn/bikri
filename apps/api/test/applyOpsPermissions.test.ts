import { env } from 'cloudflare:workers';
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

  it('accepts a costed stock-in with stock.adjust but without catalog.edit', async () => {
    const shop = await seedShop('Costed stock-in');
    await env.DB.prepare(
      'UPDATE staff SET permissions_json = ?2 WHERE tenant_id = ?1 AND id = ?3',
    )
      .bind(
        shop.tenantId,
        JSON.stringify({ 'stock.adjust': true }),
        IDS.cashier,
      )
      .run();
    const now = Date.now();
    const tx = newId(now);
    const res = await pushOk(shop.admin, [
      op(
        'products',
        'upsert',
        productRow(IDS.product, {
          avg_cost: 5000,
          last_cost: 5000,
          updated_by: IDS.cashier,
        }),
        { tx_id: tx, base_rev: 3, changed_fields: ['avg_cost', 'last_cost'] },
      ),
      op(
        'stock_movements',
        'insert',
        {
          id: newId(now),
          product_id: IDS.product,
          qty_delta_milli: 1000,
          reason_code: 'received_local',
          ref_type: 'adjustment',
          ref_id: null,
          unit_cost: 5000,
          note: '',
          branch_id: shop.branchId,
          device_id: shop.admin.id,
          staff_id: IDS.cashier,
          business_date: '2026-10-29',
          created_at: now,
        },
        { tx_id: tx },
      ),
    ]);
    expect(res.results.map((row) => row.result)).toEqual([
      'applied',
      'applied',
    ]);
  });

  it('accepts a payment to a party created earlier in the same push', async () => {
    const shop = await seedShop('New party payment');
    const now = Date.now();
    const customerId = newId(now);
    const paymentId = newId(now);
    const base = {
      branch_id: shop.branchId,
      device_id: shop.admin.id,
      staff_id: IDS.owner,
      business_date: '2026-10-29',
      created_at: now,
    };
    const createTx = newId(now);
    const payTx = newId(now);
    const res = await pushOk(shop.admin, [
      op(
        'customers',
        'upsert',
        {
          id: customerId,
          name: 'New customer',
          phone: '',
          address: '',
          note: '',
          credit_limit: null,
          hard_limit: 0,
          created_at: now,
          updated_at: now,
          updated_by: IDS.owner,
        },
        { tx_id: createTx, base_rev: 0, changed_fields: [] },
      ),
      op(
        'payments',
        'insert',
        {
          ...base,
          id: paymentId,
          direction: 'in',
          method: 'cash',
          purpose: 'customer_payment',
          amount: 5000,
          cash_tendered: null,
          change_given: null,
          reference: '',
          sale_id: null,
          refund_id: null,
          purchase_id: null,
          supplier_return_id: null,
          party_type: 'customer',
          party_id: customerId,
          note: '',
        },
        { tx_id: payTx },
      ),
      op(
        'ledger_entries',
        'insert',
        {
          ...base,
          id: newId(now),
          party_type: 'customer',
          party_id: customerId,
          amount: -5000,
          source_type: 'payment',
          source_id: paymentId,
          note: '',
        },
        { tx_id: payTx },
      ),
    ]);
    expect(res.results.map((row) => row.result)).toEqual([
      'applied',
      'applied',
      'applied',
    ]);
  });

  it('refuses to remove the last active owner', async () => {
    const shop = await seedShop('Last owner');
    const now = Date.now();
    const res = await pushOk(shop.admin, [
      op(
        'staff',
        'upsert',
        {
          id: IDS.owner,
          name: 'Owner',
          role: 'owner',
          pin_hash: 'h',
          pin_salt: 's',
          pin_iterations: 150000,
          pin_length: 4,
          permissions_json: '{}',
          active: 0,
          max_discount_bp: 10000,
          created_at: now,
          updated_at: now,
          updated_by: IDS.owner,
        },
        { base_rev: 1, changed_fields: ['active'] },
      ),
    ]);
    expect(res.results[0]).toMatchObject({
      result: 'rejected',
      error_code: 'CONSTRAINT_FAILED',
    });
  });

  it('rejects a customer payment with the wrong direction or party type', async () => {
    const shop = await seedShop('Payment direction');
    const base = {
      branch_id: shop.branchId,
      device_id: shop.admin.id,
      staff_id: IDS.owner,
      business_date: '2026-10-29',
      created_at: Date.now(),
    };
    const res = await pushOk(shop.admin, [
      op('payments', 'insert', {
        ...base,
        id: newId(),
        direction: 'out',
        method: 'cash',
        purpose: 'customer_payment',
        amount: 1000,
        cash_tendered: null,
        change_given: null,
        reference: '',
        sale_id: null,
        refund_id: null,
        purchase_id: null,
        supplier_return_id: null,
        party_type: 'customer',
        party_id: IDS.customer,
        note: '',
      }),
      op('payments', 'insert', {
        ...base,
        id: newId(),
        direction: 'out',
        method: 'cash',
        purpose: 'supplier_payment',
        amount: 1000,
        cash_tendered: null,
        change_given: null,
        reference: '',
        sale_id: null,
        refund_id: null,
        purchase_id: null,
        supplier_return_id: null,
        party_type: 'customer',
        party_id: IDS.customer,
        note: '',
      }),
    ]);
    expect(res.results.map((row) => row.error_code)).toEqual([
      'CONSTRAINT_FAILED',
      'CONSTRAINT_FAILED',
    ]);
  });

  it('rejects malformed business dates and an out-of-range sale tax rate', async () => {
    const shop = await seedShop('Row values');
    const badDate = saleOps(shop, shop.till, 1);
    badDate[0]!.row = {
      ...badDate[0]!.row,
      business_date: '2026-13-99',
    };
    const dateResult = await pushOk(shop.till, badDate);
    expect(
      dateResult.results.every((row) => row.error_code === 'CONSTRAINT_FAILED'),
    ).toBe(true);

    const badTax = saleOps(shop, shop.till, 2);
    badTax[0]!.row = { ...badTax[0]!.row, tax_rate_bp: 6000 };
    const taxResult = await pushOk(shop.till, badTax);
    expect(
      taxResult.results.every((row) => row.error_code === 'CONSTRAINT_FAILED'),
    ).toBe(true);
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
      'applied',
    ]);

    const negative = saleOps(shop, shop.till, 3, { prefix: 'NEG' });
    negative[1]!.row = {
      ...negative[1]!.row,
      gross: -1,
      net: -1,
    };
    const badLine = await pushOk(shop.till, negative);
    expect(
      badLine.results.every((row) => row.error_code === 'CONSTRAINT_FAILED'),
    ).toBe(true);

    const shortPay = saleOps(shop, shop.till, 4, { prefix: 'PAY' });
    shortPay[2]!.row = { ...shortPay[2]!.row, amount: 1 };
    const badPaid = await pushOk(shop.till, shortPay);
    expect(
      badPaid.results.every((row) => row.error_code === 'CONSTRAINT_FAILED'),
    ).toBe(true);
  });
});
