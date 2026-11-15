import { env } from 'cloudflare:workers';
import { businessDate, newId } from '@bikri/core';
import { describe, expect, it } from 'vitest';
import { IDS, type Shop, seedShop } from './helpers/fixtures.ts';
import { op, pushOk, saleOps } from './helpers/ops.ts';

function refundTransaction(
  shop: Shop,
  saleId: string,
  saleLineId: string,
  qtyMilli: number,
  amount: number,
) {
  const now = Date.now();
  const tx = newId(now);
  const refundId = newId(now);
  return {
    refundId,
    ops: [
      op(
        'refunds',
        'insert',
        {
          id: refundId,
          sale_id: saleId,
          kind: qtyMilli === 1000 ? 'whole' : 'partial',
          reason: 'Faulty',
          method: 'cash',
          exact_amount: amount,
          udhaar_part: 0,
          rounding: 0,
          amount,
          branch_id: shop.branchId,
          device_id: shop.till.id,
          staff_id: IDS.owner,
          business_date: businessDate(now),
          created_at: now,
        },
        { tx_id: tx },
      ),
      op(
        'refund_lines',
        'insert',
        {
          id: newId(now),
          refund_id: refundId,
          sale_line_id: saleLineId,
          qty_milli: qtyMilli,
          amount,
          restock: 1,
          created_at: now,
        },
        { tx_id: tx },
      ),
      op(
        'payments',
        'insert',
        {
          id: newId(now),
          direction: 'out',
          method: 'cash',
          purpose: 'refund',
          amount,
          cash_tendered: null,
          change_given: null,
          reference: '',
          sale_id: saleId,
          refund_id: refundId,
          purchase_id: null,
          supplier_return_id: null,
          party_type: null,
          party_id: null,
          note: '',
          branch_id: shop.branchId,
          device_id: shop.till.id,
          staff_id: IDS.owner,
          business_date: businessDate(now),
          created_at: now,
        },
        { tx_id: tx },
      ),
    ],
  };
}

async function saleStatus(tenantId: string, saleId: string): Promise<string> {
  const row = await env.DB.prepare(
    'SELECT status FROM sales WHERE tenant_id = ?1 AND id = ?2',
  )
    .bind(tenantId, saleId)
    .first<{ status: string }>();
  return row?.status ?? '';
}

describe('ninth review remediation', () => {
  it('checks a sale snapshot against last_cost when the shop uses cost_method=last', async () => {
    const shop = await seedShop('Review last cost');
    const now = Date.now();
    await env.DB.prepare(
      'UPDATE shop SET cost_method = ?2, updated_at = ?3 WHERE tenant_id = ?1',
    )
      .bind(shop.tenantId, 'last', now - 60_000)
      .run();
    await env.DB.prepare(
      'UPDATE products SET avg_cost = 40000, last_cost = 50000, updated_at = ?2 WHERE tenant_id = ?1 AND id = ?3',
    )
      .bind(shop.tenantId, now - 60_000, IDS.product)
      .run();
    // The server checks the snapshot once the device has seen the shop and the cost state;
    // deviceAuth maintains last_seen_at in production.
    await env.DB.prepare(
      'UPDATE devices SET last_seen_at = ?2 WHERE tenant_id = ?1 AND id = ?3',
    )
      .bind(shop.tenantId, now, shop.till.id)
      .run();
    const ops = saleOps(shop, shop.till, 1);
    const line = ops[1]?.row;
    if (line) line.unit_cost_snapshot = 50000;
    const res = await pushOk(shop.till, ops);
    expect(res.results.map((r) => r.result)).toEqual([
      'applied',
      'applied',
      'applied',
    ]);
  });

  it('stores a fully refunded sale as refunded', async () => {
    const shop = await seedShop('Review full refund');
    const sale = saleOps(shop, shop.till, 1);
    await pushOk(shop.till, sale);
    const saleId = String(sale[0]?.row?.id ?? '');
    const saleLineId = String(sale[1]?.row?.id ?? '');
    const refund = refundTransaction(shop, saleId, saleLineId, 1000, 150000);
    const res = await pushOk(shop.till, refund.ops);
    expect(res.results.map((r) => r.result)).toEqual([
      'applied',
      'applied',
      'applied',
    ]);
    expect(await saleStatus(shop.tenantId, saleId)).toBe('refunded');
  });

  it('moves a sale through part_refunded to refunded across two refunds', async () => {
    const shop = await seedShop('Review partial refunds');
    const sale = saleOps(shop, shop.till, 1);
    await pushOk(shop.till, sale);
    const saleId = String(sale[0]?.row?.id ?? '');
    const saleLineId = String(sale[1]?.row?.id ?? '');
    await pushOk(
      shop.till,
      refundTransaction(shop, saleId, saleLineId, 500, 75000).ops,
    );
    expect(await saleStatus(shop.tenantId, saleId)).toBe('part_refunded');
    await pushOk(
      shop.till,
      refundTransaction(shop, saleId, saleLineId, 500, 75000).ops,
    );
    expect(await saleStatus(shop.tenantId, saleId)).toBe('refunded');
  });
});
