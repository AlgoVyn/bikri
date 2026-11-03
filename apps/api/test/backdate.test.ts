import { env } from 'cloudflare:workers';
import { businessDate, newId } from '@bikri/core';
import { describe, expect, it } from 'vitest';
import { IDS, seedShop } from './helpers/fixtures.ts';
import { op, pushOk, saleOps } from './helpers/ops.ts';

const TZ = 'Asia/Karachi';
const now = Date.now();
const today = businessDate(now, TZ);

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** A sale from a past business date, recorded now on the till (D-173). */
function backdatedSale(
  shop: Awaited<ReturnType<typeof seedShop>>,
  opts: {
    date: string;
    recorder?: string;
    withAudit?: boolean;
    seq?: number;
  },
) {
  const ops = saleOps(shop, shop.till, opts.seq ?? 1);
  const saleOp = ops[0];
  const tx = String(saleOp?.tx_id);
  const saleId = String(saleOp?.row?.id);
  const recordedAt = Date.now();
  for (const entry of ops) {
    entry.created_at = recordedAt;
    if (entry.row && 'business_date' in entry.row)
      entry.row.business_date = opts.date;
    if (entry.row && entry.tbl !== 'sales') entry.row.created_at = recordedAt;
  }
  if (opts.withAudit !== false)
    ops.push(
      op(
        'audit_log',
        'insert',
        {
          id: newId(recordedAt),
          action: 'sale_backdated',
          entity: 'sales',
          entity_id: saleId,
          before_json: null,
          after_json: JSON.stringify({
            attributed_staff_id: IDS.cashier,
            business_date: opts.date,
            reason: 'Cashier forgot to enter it',
            recorded_at: recordedAt,
          }),
          device_id: shop.till.id,
          staff_id: opts.recorder ?? IDS.owner,
          created_at: recordedAt,
        },
        { tx_id: tx, created_at: recordedAt },
      ),
    );
  return { ops, saleId };
}

const count = async (sql: string, ...params: unknown[]) =>
  Number(
    (
      await env.DB.prepare(sql)
        .bind(...params)
        .first<{ n: number }>()
    )?.n ?? 0,
  );

describe('backdated sales (D-173)', () => {
  it('accepts an owner-recorded sale on a past business date and keeps the cashier attribution', async () => {
    const shop = await seedShop('Backdate');
    const date = addDays(today, -1);
    const { ops, saleId } = backdatedSale(shop, { date });
    const res = await pushOk(shop.till, ops);
    expect(res.results.map((r) => r.error_code ?? null)).toEqual([
      null,
      null,
      null,
      null,
    ]);
    const sale = await env.DB.prepare(
      'SELECT business_date, staff_id, created_at FROM sales WHERE tenant_id = ?1 AND id = ?2',
    )
      .bind(shop.tenantId, saleId)
      .first<{ business_date: string; staff_id: string; created_at: number }>();
    expect(sale?.business_date).toBe(date);
    expect(sale?.staff_id).toBe(IDS.cashier);
    expect(
      await count(
        "SELECT COUNT(*) AS n FROM audit_log WHERE tenant_id = ?1 AND action = 'sale_backdated' AND entity_id = ?2",
        shop.tenantId,
        saleId,
      ),
    ).toBe(1);
  });

  it('rejects a past sale without the owner audit row', async () => {
    const shop = await seedShop('BackdateNoAudit');
    const { ops } = backdatedSale(shop, {
      date: addDays(today, -1),
      withAudit: false,
    });
    const res = await pushOk(shop.till, ops);
    expect(res.results[0]?.error_code).toBe('FORBIDDEN');
  });

  it('rejects an audit written by a cashier without sale.backdate', async () => {
    const shop = await seedShop('BackdateCashier');
    const { ops } = backdatedSale(shop, {
      date: addDays(today, -1),
      recorder: IDS.cashier,
    });
    const res = await pushOk(shop.till, ops);
    expect(res.results[0]?.error_code).toBe('FORBIDDEN');
  });

  it('accepts a date older than 30 days and rejects a future date', async () => {
    const shop = await seedShop('BackdateRange');
    const old = await pushOk(
      shop.till,
      backdatedSale(shop, { date: addDays(today, -400), seq: 1 }).ops,
    );
    expect(old.results.map((r) => r.error_code ?? null)).toEqual([
      null,
      null,
      null,
      null,
    ]);
    const future = await pushOk(
      shop.till,
      backdatedSale(shop, { date: addDays(today, 1), seq: 2 }).ops,
    );
    expect(future.results[0]?.error_code).toBe('CONSTRAINT_FAILED');
  });

  it('accepts a genuine offline sale whose op timestamp is on its own business date', async () => {
    const shop = await seedShop('BackdateOffline');
    const offlineAt = now - 6 * 60 * 60 * 1000;
    const date = businessDate(offlineAt, TZ);
    const ops = saleOps(shop, shop.till, 1);
    for (const entry of ops) {
      entry.created_at = offlineAt;
      if (entry.row && 'business_date' in entry.row)
        entry.row.business_date = date;
      if (entry.row) entry.row.created_at = offlineAt;
    }
    const res = await pushOk(shop.till, ops);
    expect(res.results.map((r) => r.error_code ?? null)).toEqual([
      null,
      null,
      null,
    ]);
  });
});
