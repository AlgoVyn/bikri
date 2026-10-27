import {
  computeDayClose,
  mulDivRound,
  refundedCost,
  refundedRevenue,
} from '@bikri/core';
import type { BikriDb, SyncedRow } from '@bikri/db';

/** Business-date range (inclusive), optionally one device (07 §9). */
export type ReportRange = { from: string; to: string; deviceId?: string };

export type Summary = {
  sold: number;
  bills: number;
  grossProfit: number;
  udhaarGiven: number;
  udhaarReceived: number;
};

const n = (v: unknown) => Number(v ?? 0);

function inRange(row: SyncedRow, range: ReportRange): boolean {
  const date = String(row.business_date);
  if (date < range.from || date > range.to) return false;
  return range.deviceId === undefined || row.device_id === range.deviceId;
}

/** 07 §1: profit uses revenue ex-tax and ex-rounding. */
export function lineRevenue(line: SyncedRow, taxInclusive: boolean): number {
  return (
    n(line.net) -
    n(line.bill_discount_alloc) -
    (taxInclusive ? n(line.tax_alloc) : 0)
  );
}

/** Sold, bills, gross profit and udhaar figures for a range (07 §9). Refunds count on their own date. */
export async function summary(
  db: BikriDb,
  range: ReportRange,
): Promise<Summary> {
  const sales = (
    await db.sales
      .where('business_date')
      .between(range.from, range.to, true, true)
      .toArray()
  ).filter((s) => inRange(s, range) && s.status !== 'void');
  const refunds = (
    await db.refunds
      .where('business_date')
      .between(range.from, range.to, true, true)
      .toArray()
  ).filter((r) => inRange(r, range));
  const out: Summary = {
    sold: 0,
    bills: sales.length,
    grossProfit: 0,
    udhaarGiven: 0,
    udhaarReceived: 0,
  };
  for (const sale of sales) {
    out.sold += n(sale.total);
    out.udhaarGiven += n(sale.udhaar_amount);
    for (const line of await db.sale_lines
      .where('sale_id')
      .equals(sale.id)
      .toArray()) {
      out.grossProfit +=
        lineRevenue(line, sale.tax_inclusive === 1) -
        mulDivRound(n(line.qty_milli), n(line.unit_cost_snapshot), 1000);
    }
  }
  for (const refund of refunds) {
    out.sold -= n(refund.amount) + n(refund.udhaar_part);
    out.udhaarGiven -= n(refund.udhaar_part);
    for (const rl of await db.refund_lines
      .where('refund_id')
      .equals(refund.id)
      .toArray()) {
      const line = await db.sale_lines.get(String(rl.sale_line_id));
      if (!line) continue;
      const sale = await db.sales.get(String(line.sale_id));
      const earlier = (
        await db.refund_lines.where('sale_line_id').equals(line.id).toArray()
      ).filter(
        (x) =>
          n(x.created_at) < n(rl.created_at) ||
          (n(x.created_at) === n(rl.created_at) && x.id < rl.id),
      );
      const prev = earlier.reduce((s, x) => s + n(x.qty_milli), 0);
      const q = n(rl.qty_milli);
      out.grossProfit -=
        refundedRevenue(
          lineRevenue(line, sale?.tax_inclusive === 1),
          n(line.qty_milli),
          prev,
          q,
        ) - refundedCost(n(line.unit_cost_snapshot), prev, q);
    }
  }
  const received = await db.payments
    .where('business_date')
    .between(range.from, range.to, true, true)
    .toArray();
  for (const p of received) {
    if (
      inRange(p, range) &&
      p.purpose === 'customer_payment' &&
      p.direction === 'in'
    )
      out.udhaarReceived += n(p.amount);
  }
  return out;
}

/** Expected cash in this device's drawer since its last close (07 §8). */
export async function expectedCash(
  db: BikriDb,
  deviceId: string,
  now = Date.now(),
): Promise<number> {
  const closes = await db.day_closes
    .where('[device_id+period_end]')
    .between([deviceId, 0], [deviceId, now])
    .toArray();
  const last = closes.at(-1);
  const device = await db.devices.get(deviceId);
  const start = last ? n(last.period_end) : n(device?.created_at);
  const since = <T extends SyncedRow>(rows: T[]) =>
    rows.filter((r) => n(r.created_at) > start && n(r.created_at) <= now);
  const payments = since(
    await db.payments
      .where('[device_id+created_at]')
      .between([deviceId, start], [deviceId, now], false, true)
      .toArray(),
  ).filter((p) => p.method === 'cash');
  const sum = (rows: SyncedRow[]) => rows.reduce((s, r) => s + n(r.amount), 0);
  const pick = (direction: string, purposes: string[]) =>
    sum(
      payments.filter(
        (p) =>
          p.direction === direction && purposes.includes(String(p.purpose)),
      ),
    );
  const moves = since(
    await db.cash_moves
      .where('[device_id+created_at]')
      .between([deviceId, start], [deviceId, now], false, true)
      .toArray(),
  );
  const expenses = since(
    await db.expenses
      .where('[device_id+created_at]')
      .between([deviceId, start], [deviceId, now], false, true)
      .toArray(),
  ).filter((e) => e.method === 'cash');
  return computeDayClose({
    opening_cash: last ? n(last.counted_cash) : 0,
    cash_sales: pick('in', ['sale']),
    udhaar_cash_in: pick('in', ['customer_payment']),
    pay_ins: sum(moves.filter((m) => m.kind === 'pay_in')),
    supplier_cash_in: pick('in', ['supplier_refund']),
    cash_refunds: pick('out', ['refund', 'void']),
    cash_expenses:
      sum(expenses.filter((e) => !e.reverses_id)) -
      sum(expenses.filter((e) => e.reverses_id)),
    supplier_cash_out: pick('out', ['supplier_payment', 'purchase_paid_now']),
    pay_outs: sum(moves.filter((m) => m.kind === 'pay_out')),
    counted_cash: 0,
  }).expected_cash;
}
