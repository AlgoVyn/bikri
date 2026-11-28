import { env } from 'cloudflare:workers';
import { newId } from '@bikri/core';
import { describe, expect, it } from 'vitest';
import {
  addBundleFixture,
  api,
  IDS,
  json,
  seedShop,
} from './helpers/fixtures.ts';
import { op, pullAll, pushOk, quoteOps, saleOps } from './helpers/ops.ts';

const count = async (sql: string, ...params: unknown[]) =>
  Number(
    (
      await env.DB.prepare(sql)
        .bind(...params)
        .first<{ n: number }>()
    )?.n ?? 0,
  );

describe('quotations (D-305)', () => {
  it('applies a quote and its lines without stock, payment or ledger rows', async () => {
    const shop = await seedShop('Quote push');
    const quote = quoteOps(shop, shop.till, 1);
    const res = await pushOk(shop.till, quote.ops);
    expect(res.results.map((row) => row.result)).toEqual([
      'applied',
      'applied',
    ]);
    expect(
      await count(
        'SELECT COUNT(*) AS n FROM quotations WHERE tenant_id = ?1',
        shop.tenantId,
      ),
    ).toBe(1);
    expect(
      await count(
        'SELECT COUNT(*) AS n FROM quotation_lines WHERE tenant_id = ?1',
        shop.tenantId,
      ),
    ).toBe(1);
    expect(
      await count(
        'SELECT COUNT(*) AS n FROM stock_movements WHERE tenant_id = ?1',
        shop.tenantId,
      ),
    ).toBe(0);
    expect(
      await count(
        'SELECT COUNT(*) AS n FROM payments WHERE tenant_id = ?1',
        shop.tenantId,
      ),
    ).toBe(0);
    expect(
      await count(
        'SELECT COUNT(*) AS n FROM ledger_entries WHERE tenant_id = ?1',
        shop.tenantId,
      ),
    ).toBe(0);
    expect(
      await env.DB.prepare(
        'SELECT last_quote_seq FROM devices WHERE tenant_id = ?1 AND id = ?2',
      )
        .bind(shop.tenantId, shop.till.id)
        .first<{ last_quote_seq: number }>(),
    ).toEqual({ last_quote_seq: 1 });
  });

  it('edits an open quote and rejects a cancelled one', async () => {
    const shop = await seedShop('Quote edit');
    const quote = quoteOps(shop, shop.till, 1);
    await pushOk(shop.till, quote.ops);
    const edit = op(
      'quotations',
      'upsert',
      { ...quote.row, note: 'Updated terms' },
      { base_rev: 1, changed_fields: ['note'] },
    );
    const res = await pushOk(shop.till, [edit]);
    expect(res.results[0]?.result).toBe('applied');
    const stored = await env.DB.prepare(
      'SELECT note FROM quotations WHERE tenant_id = ?1 AND id = ?2',
    )
      .bind(shop.tenantId, quote.quoteId)
      .first<{ note: string }>();
    expect(stored?.note).toBe('Updated terms');

    const cancel = op(
      'quotations',
      'upsert',
      {
        ...quote.row,
        status: 'cancelled',
        cancelled_reason: 'No',
        cancelled_at: Date.now(),
      },
      {
        base_rev: 2,
        changed_fields: ['status', 'cancelled_reason', 'cancelled_at'],
      },
    );
    const cancelled = await pushOk(shop.till, [cancel]);
    expect(cancelled.results[0]?.result).toBe('applied');
    const lateEdit = op(
      'quotations',
      'upsert',
      { ...quote.row, note: 'late' },
      { base_rev: 3, changed_fields: ['note'] },
    );
    const rejected = await pushOk(shop.till, [lateEdit]);
    expect(rejected.results[0]?.result).toBe('rejected');
    expect(rejected.results[0]?.error_code).toBe('CONSTRAINT_FAILED');
  });

  it('rejects a wrong total, a wrong quote number and a cross-device quote', async () => {
    const shop = await seedShop('Quote invalid');
    const badTotal = quoteOps(shop, shop.till, 1);
    if (badTotal.ops[0]?.row) badTotal.ops[0].row.total = 1;
    const r1 = await pushOk(shop.till, badTotal.ops);
    expect(r1.results.every((row) => row.result === 'rejected')).toBe(true);
    const badNo = quoteOps(shop, shop.till, 2);
    badNo.row.quote_no = 'INV-B-2';
    const r2 = await pushOk(shop.till, badNo.ops);
    expect(r2.results[0]).toMatchObject({
      result: 'rejected',
      error_code: 'CONSTRAINT_FAILED',
    });
    const wrongDevice = quoteOps(shop, shop.admin, 1);
    const r3 = await pushOk(shop.till, wrongDevice.ops);
    expect(r3.results[0]).toMatchObject({
      result: 'rejected',
      error_code: 'FORBIDDEN',
    });
  });

  it('converts a quote in the same action as its sale, and accepts a second offline conversion', async () => {
    const shop = await seedShop('Quote convert');
    const quote = quoteOps(shop, shop.till, 1);
    await pushOk(shop.till, quote.ops);
    const sale = saleOps(shop, shop.till, 1, { total: 150000 });
    const saleId = String(sale[0]?.row?.id ?? '');
    const tx = String(sale[0]?.tx_id ?? '');
    const convert = op(
      'quotations',
      'upsert',
      {
        ...quote.row,
        status: 'converted',
        converted_sale_id: saleId,
        converted_at: Date.now(),
      },
      {
        tx_id: tx,
        base_rev: 1,
        changed_fields: ['status', 'converted_sale_id', 'converted_at'],
      },
    );
    const res = await pushOk(shop.till, [...sale, convert]);
    expect(res.results.at(-1)).toMatchObject({ result: 'applied' });
    const stored = await env.DB.prepare(
      'SELECT status, converted_sale_id FROM quotations WHERE tenant_id = ?1 AND id = ?2',
    )
      .bind(shop.tenantId, quote.quoteId)
      .first<{ status: string; converted_sale_id: string }>();
    expect(stored).toEqual({ status: 'converted', converted_sale_id: saleId });

    // A second till converted the same quote offline: both sales stay, the last link wins.
    const second = saleOps(shop, shop.till, 2, { total: 150000 });
    const secondId = String(second[0]?.row?.id ?? '');
    const again = op(
      'quotations',
      'upsert',
      {
        ...quote.row,
        status: 'converted',
        converted_sale_id: secondId,
        converted_at: Date.now(),
      },
      {
        tx_id: String(second[0]?.tx_id ?? ''),
        base_rev: 2,
        changed_fields: ['status', 'converted_sale_id', 'converted_at'],
      },
    );
    const secondRes = await pushOk(shop.till, [...second, again]);
    expect(secondRes.results.at(-1)).toMatchObject({ result: 'applied' });
    expect(
      await env.DB.prepare(
        'SELECT converted_sale_id FROM quotations WHERE tenant_id = ?1 AND id = ?2',
      )
        .bind(shop.tenantId, quote.quoteId)
        .first<{ converted_sale_id: string }>(),
    ).toEqual({ converted_sale_id: secondId });
  });

  it('writes and validates a bundle quote as component snapshot lines', async () => {
    const shop = await seedShop('Quote bundle');
    const bundle = await addBundleFixture(shop, 'Quote');
    const base = quoteOps(shop, shop.till, 1);
    const tx = newId();
    const group = newId();
    const total = 200000;
    const header = {
      ...base.row,
      line_count: 4,
      items_qty_milli: 4000,
      gross_total: total,
      subtotal: total,
      total,
    };
    const line = (index: number) => ({
      ...base.line,
      id: newId(),
      line_no: index + 1,
      product_id: bundle.componentIds[index],
      name_snapshot: `Component ${index + 1}`,
      unit_price: 50000,
      gross: 50000,
      net: 50000,
      bundle_id: bundle.bundleId,
      bundle_group: group,
      bundle_name: 'Bundle',
      bundle_qty: 1,
      bundle_price: total,
      bundle_component_qty_milli: 1000,
    });
    const lines = [0, 1, 2, 3].map(line);
    const res = await pushOk(shop.till, [
      op('quotations', 'upsert', header, { tx_id: tx, base_rev: 0 }),
      ...lines.map((row) =>
        op('quotation_lines', 'upsert', row, { tx_id: tx, base_rev: 0 }),
      ),
    ]);
    expect(res.results.map((row) => row.result)).toEqual([
      'applied',
      'applied',
      'applied',
      'applied',
      'applied',
    ]);
    expect(
      await count(
        'SELECT COUNT(*) AS n FROM quotation_lines WHERE tenant_id = ?1 AND bundle_group = ?2',
        shop.tenantId,
        group,
      ),
    ).toBe(4);

    // A component whose bundle quantities disagree is not a valid recipe snapshot.
    const badTx = newId();
    const bad = { ...base.row, line_count: 4, items_qty_milli: 4000 };
    const badGroup = newId();
    const badLines = [0, 1, 2, 3].map((index) => ({
      ...line(index),
      id: newId(),
      bundle_group: badGroup,
      bundle_qty: index === 3 ? 2 : 1,
    }));
    const rejected = await pushOk(shop.till, [
      op('quotations', 'upsert', bad, { tx_id: badTx, base_rev: 0 }),
      ...badLines.map((row) =>
        op('quotation_lines', 'upsert', row, { tx_id: badTx, base_rev: 0 }),
      ),
    ]);
    expect(
      rejected.results.filter((row) => row.result === 'rejected'),
    ).not.toHaveLength(0);
  });

  it('deletes a quote line together with the updated header', async () => {
    const shop = await seedShop('Quote line delete');
    const base = quoteOps(shop, shop.till, 1);
    const tx = newId();
    const line2 = {
      ...base.line,
      id: newId(),
      line_no: 2,
      name_snapshot: 'Phone 2',
    };
    await pushOk(shop.till, [
      op(
        'quotations',
        'upsert',
        {
          ...base.row,
          line_count: 2,
          items_qty_milli: 2000,
          gross_total: 300000,
          subtotal: 300000,
          total: 300000,
        },
        { tx_id: tx, base_rev: 0 },
      ),
      op('quotation_lines', 'upsert', base.line, { tx_id: tx, base_rev: 0 }),
      op('quotation_lines', 'upsert', line2, { tx_id: tx, base_rev: 0 }),
    ]);
    const editTx = newId();
    const after = await pushOk(shop.till, [
      op(
        'quotations',
        'upsert',
        {
          ...base.row,
          line_count: 1,
          items_qty_milli: 1000,
          gross_total: 150000,
          subtotal: 150000,
          total: 150000,
        },
        {
          tx_id: editTx,
          base_rev: 1,
          changed_fields: [
            'line_count',
            'items_qty_milli',
            'gross_total',
            'subtotal',
            'total',
          ],
        },
      ),
      op(
        'quotation_lines',
        'delete',
        { id: line2.id },
        { tx_id: editTx, base_rev: 1 },
      ),
    ]);
    expect(after.results.map((row) => row.result)).toEqual([
      'applied',
      'applied',
    ]);
    expect(
      await count(
        'SELECT COUNT(*) AS n FROM quotation_lines WHERE tenant_id = ?1 AND quote_id = ?2 AND deleted_at IS NULL',
        shop.tenantId,
        base.quoteId,
      ),
    ).toBe(1);
  });

  it('hides quotation tables from clients below schema 10', async () => {
    const shop = await seedShop('Quote schema gate');
    await pushOk(shop.till, quoteOps(shop, shop.till, 1).ops);
    const old = await json<{ changes: Array<{ tbl: string }> }>(
      await api('/sync/pull?since=0', {
        token: shop.till.token,
        headers: { 'x-bikri-schema': '9' },
      }),
    );
    expect(old.changes.some((c) => c.tbl === 'quotations')).toBe(false);
    const oldSnap = await json<{ rows: unknown[]; has_more: boolean }>(
      await api('/sync/snapshot?tbl=quotations', {
        token: shop.till.token,
        headers: { 'x-bikri-schema': '9' },
      }),
    );
    expect(oldSnap).toMatchObject({
      tbl: 'quotations',
      rows: [],
      next_after: '',
      has_more: false,
    });
    const current = await json<{ changes: Array<{ tbl: string }> }>(
      await api('/sync/pull?since=0', {
        token: shop.till.token,
        headers: { 'x-bikri-schema': '10' },
      }),
    );
    expect(current.changes.some((c) => c.tbl === 'quotations')).toBe(true);
  });

  it('syncs a quote to another till in the same shop and converts it there', async () => {
    const shop = await seedShop('Quote two tills');
    const quote = quoteOps(shop, shop.till, 1, { note: 'Shared quote' });
    await pushOk(shop.till, quote.ops);
    const pulled = await pullAll(shop.admin);
    expect(
      pulled.find((change) => change.tbl === 'quotations')?.row,
    ).toMatchObject({ id: quote.quoteId, note: 'Shared quote' });
    expect(
      pulled.filter((change) => change.tbl === 'quotation_lines'),
    ).toHaveLength(1);

    const sale = saleOps(shop, shop.admin, 1, { total: 150000 });
    const saleId = String(sale[0]?.row?.id ?? '');
    const convert = op(
      'quotations',
      'upsert',
      {
        ...quote.row,
        status: 'converted',
        converted_sale_id: saleId,
        converted_at: Date.now(),
      },
      {
        tx_id: String(sale[0]?.tx_id ?? ''),
        base_rev: 1,
        changed_fields: ['status', 'converted_sale_id', 'converted_at'],
      },
    );
    const res = await pushOk(shop.admin, [...sale, convert]);
    expect(res.results.at(-1)).toMatchObject({ result: 'applied' });
    const back = await pullAll(shop.till);
    expect(
      back
        .filter(
          (change) =>
            change.tbl === 'quotations' && change.row.id === quote.quoteId,
        )
        .at(-1)?.row,
    ).toMatchObject({ status: 'converted', converted_sale_id: saleId });
  });

  it('allows a second edit after a quote line was soft-deleted', async () => {
    const shop = await seedShop('Quote delete edit');
    const base = quoteOps(shop, shop.till, 1);
    const tx = newId();
    const makeLine = (lineNo: number) => ({
      ...base.line,
      id: newId(),
      line_no: lineNo,
      unit_price: 150000,
      gross: 150000,
      net: 150000,
    });
    const first = makeLine(1);
    const second = makeLine(2);
    const header = {
      ...base.row,
      line_count: 2,
      items_qty_milli: 2000,
      gross_total: 300000,
      subtotal: 300000,
      total: 300000,
    };
    await pushOk(shop.till, [
      op('quotations', 'upsert', header, { tx_id: tx, base_rev: 0 }),
      op('quotation_lines', 'upsert', first, { tx_id: tx, base_rev: 0 }),
      op('quotation_lines', 'upsert', second, { tx_id: tx, base_rev: 0 }),
    ]);

    const deleteTx = newId();
    const oneLine = {
      ...header,
      line_count: 1,
      items_qty_milli: 1000,
      gross_total: 150000,
      subtotal: 150000,
      total: 150000,
    };
    const deleted = await pushOk(shop.till, [
      op('quotations', 'upsert', oneLine, {
        tx_id: deleteTx,
        base_rev: 1,
        changed_fields: [
          'line_count',
          'items_qty_milli',
          'gross_total',
          'subtotal',
          'total',
        ],
      }),
      op(
        'quotation_lines',
        'delete',
        { id: second.id },
        {
          tx_id: deleteTx,
          base_rev: 1,
        },
      ),
    ]);
    expect(deleted.results.map((row) => row.result)).toEqual([
      'applied',
      'applied',
    ]);

    const later = await pushOk(shop.till, [
      op(
        'quotations',
        'upsert',
        { ...oneLine, note: 'Second edit' },
        {
          base_rev: 2,
          changed_fields: ['note'],
        },
      ),
    ]);
    expect(later.results[0]).toMatchObject({ result: 'applied' });
    expect(
      await env.DB.prepare(
        'SELECT note FROM quotations WHERE tenant_id = ?1 AND id = ?2',
      )
        .bind(shop.tenantId, base.quoteId)
        .first<{ note: string }>(),
    ).toEqual({ note: 'Second edit' });
  });

  it('does not advance last_quote_seq for a rejected quote', async () => {
    const shop = await seedShop('Quote rejected seq');
    const bad = quoteOps(shop, shop.till, 9);
    if (bad.ops[0]?.row) bad.ops[0].row.total = 1;
    await pushOk(shop.till, bad.ops);
    expect(
      await env.DB.prepare(
        'SELECT last_quote_seq FROM devices WHERE tenant_id = ?1 AND id = ?2',
      )
        .bind(shop.tenantId, shop.till.id)
        .first<{ last_quote_seq: number }>(),
    ).toEqual({ last_quote_seq: 0 });
  });

  it('API-H1: empty changed_fields cannot reopen a cancelled quote', async () => {
    const shop = await seedShop('Quote reopen');
    const quote = quoteOps(shop, shop.till, 1);
    await pushOk(shop.till, quote.ops);
    const now = Date.now();
    await pushOk(shop.till, [
      op(
        'quotations',
        'upsert',
        {
          ...quote.row,
          status: 'cancelled',
          cancelled_reason: 'No',
          cancelled_at: now,
        },
        {
          tx_id: newId(now),
          base_rev: 1,
          changed_fields: ['status', 'cancelled_reason', 'cancelled_at'],
        },
      ),
    ]);
    const phantom = op(
      'quotations',
      'upsert',
      {
        ...quote.row,
        status: 'open',
        cancelled_at: null,
        cancelled_reason: '',
        note: 'phantom open',
      },
      { tx_id: newId(now), base_rev: 2, changed_fields: [] },
    );
    const applied = await pushOk(shop.till, [phantom]);
    expect(applied.results[0]?.result).toBe('applied');
    const stored = await env.DB.prepare(
      'SELECT status, note FROM quotations WHERE tenant_id = ?1 AND id = ?2',
    )
      .bind(shop.tenantId, quote.quoteId)
      .first<{ status: string; note: string }>();
    expect(stored).toEqual({ status: 'cancelled', note: '' });
    const reopen = op(
      'quotations',
      'upsert',
      {
        ...quote.row,
        status: 'open',
        cancelled_at: null,
        cancelled_reason: '',
        note: 'reopened',
      },
      {
        tx_id: newId(now),
        base_rev: 3,
        changed_fields: ['status', 'cancelled_at', 'cancelled_reason', 'note'],
      },
    );
    const rejected = await pushOk(shop.till, [reopen]);
    expect(rejected.results[0]).toMatchObject({
      result: 'rejected',
      error_code: 'CONSTRAINT_FAILED',
    });
  });

  it('API-H2: a line from a cancelled quote cannot be re-parented into an open quote', async () => {
    const shop = await seedShop('Quote line theft');
    const first = quoteOps(shop, shop.till, 1);
    const second = quoteOps(shop, shop.till, 2);
    await pushOk(shop.till, [...first.ops, ...second.ops]);
    const now = Date.now();
    await pushOk(shop.till, [
      op(
        'quotations',
        'upsert',
        {
          ...first.row,
          status: 'cancelled',
          cancelled_reason: 'No',
          cancelled_at: now,
        },
        {
          tx_id: newId(now),
          base_rev: 1,
          changed_fields: ['status', 'cancelled_reason', 'cancelled_at'],
        },
      ),
    ]);
    const tx = newId(now);
    const line = {
      ...first.line,
      quote_id: second.quoteId,
      line_no: 2,
      name_snapshot: 'Stolen',
    };
    const header = {
      ...second.row,
      line_count: 2,
      items_qty_milli: 2000,
      gross_total: 300000,
      subtotal: 300000,
      total: 300000,
    };
    const res = await pushOk(shop.till, [
      op('quotation_lines', 'upsert', line, {
        tx_id: tx,
        base_rev: 1,
        changed_fields: Object.keys(line).filter((key) => key !== 'id'),
      }),
      op('quotations', 'upsert', header, {
        tx_id: tx,
        base_rev: 1,
        changed_fields: [
          'line_count',
          'items_qty_milli',
          'gross_total',
          'subtotal',
          'total',
        ],
      }),
    ]);
    expect(res.results.every((row) => row.result === 'rejected')).toBe(true);
    expect(
      await env.DB.prepare(
        'SELECT quote_id, name_snapshot FROM quotation_lines WHERE tenant_id = ?1 AND id = ?2',
      )
        .bind(shop.tenantId, first.line.id)
        .first<{ quote_id: string; name_snapshot: string }>(),
    ).toEqual({ quote_id: first.quoteId, name_snapshot: 'Phone' });
  });

  it('API-H3: a conversion racing an offline cancel still commits the sale', async () => {
    const shop = await seedShop('Quote cancel convert');
    const quote = quoteOps(shop, shop.till, 1);
    await pushOk(shop.till, quote.ops);
    const now = Date.now();
    await pushOk(shop.till, [
      op(
        'quotations',
        'upsert',
        {
          ...quote.row,
          status: 'cancelled',
          cancelled_reason: 'No',
          cancelled_at: now,
        },
        {
          tx_id: newId(now),
          base_rev: 1,
          changed_fields: ['status', 'cancelled_reason', 'cancelled_at'],
        },
      ),
    ]);
    const sale = saleOps(shop, shop.till, 1);
    const saleId = String(sale[0]?.row?.id ?? '');
    const tx = String(sale[0]?.tx_id ?? '');
    const convert = op(
      'quotations',
      'upsert',
      {
        ...quote.row,
        status: 'converted',
        converted_sale_id: saleId,
        converted_at: now,
        cancelled_at: null,
        cancelled_reason: '',
      },
      {
        tx_id: tx,
        base_rev: 2,
        changed_fields: [
          'status',
          'converted_sale_id',
          'converted_at',
          'cancelled_at',
          'cancelled_reason',
        ],
      },
    );
    const res = await pushOk(shop.till, [...sale, convert]);
    expect(res.results.at(-1)).toMatchObject({ result: 'applied' });
    const stored = await env.DB.prepare(
      'SELECT status, converted_sale_id FROM quotations WHERE tenant_id = ?1 AND id = ?2',
    )
      .bind(shop.tenantId, quote.quoteId)
      .first<{ status: string; converted_sale_id: string }>();
    expect(stored).toEqual({
      status: 'converted',
      converted_sale_id: saleId,
    });
    const replay = op(
      'quotations',
      'upsert',
      {
        ...quote.row,
        status: 'converted',
        converted_sale_id: saleId,
        converted_at: now,
        cancelled_at: null,
        cancelled_reason: '',
      },
      {
        tx_id: newId(now),
        base_rev: 3,
        changed_fields: [
          'status',
          'converted_sale_id',
          'converted_at',
          'cancelled_at',
          'cancelled_reason',
        ],
      },
    );
    expect((await pushOk(shop.till, [replay])).results[0]?.result).toBe(
      'applied',
    );
  });

  it('API-M1: a cross-till quote edit does not advance the editor device sequence', async () => {
    const shop = await seedShop('Quote cross till seq');
    const quote = quoteOps(shop, shop.till, 1);
    await pushOk(shop.till, quote.ops);
    const edit = op(
      'quotations',
      'upsert',
      { ...quote.row, note: 'Admin edit' },
      { base_rev: 1, changed_fields: ['note'] },
    );
    expect((await pushOk(shop.admin, [edit])).results[0]?.result).toBe(
      'applied',
    );
    expect(
      await env.DB.prepare(
        'SELECT last_quote_seq FROM devices WHERE tenant_id = ?1 AND id = ?2',
      )
        .bind(shop.tenantId, shop.admin.id)
        .first<{ last_quote_seq: number }>(),
    ).toEqual({ last_quote_seq: 0 });
  });

  it('API-M2: a cashier cannot create an over-limit quote discount', async () => {
    const shop = await seedShop('Quote discount policy');
    const quote = quoteOps(shop, shop.till, 1, { staffId: IDS.cashier });
    const discounted = {
      ...quote.row,
      bill_discount_type: 'rs',
      bill_discount_value: 50000,
      bill_discount: 50000,
      subtotal: 150000,
      total: 100000,
    };
    const tx = newId();
    const res = await pushOk(shop.till, [
      op('quotations', 'upsert', discounted, {
        tx_id: tx,
        base_rev: 0,
        changed_fields: Object.keys(discounted).filter((key) => key !== 'id'),
      }),
      op('quotation_lines', 'upsert', quote.line, {
        tx_id: tx,
        base_rev: 0,
        changed_fields: Object.keys(quote.line).filter((key) => key !== 'id'),
      }),
    ]);
    expect(res.results.every((row) => row.result === 'rejected')).toBe(true);
    expect(res.results[0]?.error_code).toBe('FORBIDDEN');
  });

  it('cancels a quote after the catalogue price moved or the product became a bundle', async () => {
    const shop = await seedShop('Quote cancel policy');
    const quote = quoteOps(shop, shop.till, 1);
    const priced = {
      ...quote.row,
      gross_total: 100000,
      subtotal: 100000,
      total: 100000,
    };
    const line = {
      ...quote.line,
      unit_price: 100000,
      gross: 100000,
      net: 100000,
    };
    const tx = newId();
    const created = await pushOk(shop.till, [
      op('quotations', 'upsert', priced, {
        tx_id: tx,
        base_rev: 0,
        changed_fields: Object.keys(priced).filter((key) => key !== 'id'),
      }),
      op('quotation_lines', 'upsert', line, {
        tx_id: tx,
        base_rev: 0,
        changed_fields: Object.keys(line).filter((key) => key !== 'id'),
      }),
    ]);
    expect(created.results.every((row) => row.result === 'applied')).toBe(true);
    // The owner converted the simple product to a bundle after the quote was saved.
    await env.DB.prepare(
      "UPDATE products SET kind = 'bundle', track_stock = 0 WHERE tenant_id = ?1 AND id = ?2",
    )
      .bind(shop.tenantId, IDS.product)
      .run();
    const now = Date.now();
    const cancelled = await pushOk(shop.till, [
      op(
        'quotations',
        'upsert',
        {
          ...priced,
          status: 'cancelled',
          cancelled_reason: 'No',
          cancelled_at: now,
          updated_by: IDS.cashier,
        },
        {
          base_rev: 1,
          changed_fields: ['status', 'cancelled_reason', 'cancelled_at'],
        },
      ),
    ]);
    expect(cancelled.results[0]).toMatchObject({ result: 'applied' });
  });

  it('API-M2: a standalone line cannot point at a bundle product', async () => {
    const shop = await seedShop('Quote bundle product line');
    await addBundleFixture(shop);
    const quote = quoteOps(shop, shop.till, 1);
    (quote.line as { product_id: string }).product_id = IDS.bundle;
    const res = await pushOk(shop.till, quote.ops);
    expect(res.results.every((row) => row.result === 'rejected')).toBe(true);
  });
});
