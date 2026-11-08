import {
  computeDayClose,
  lineRevenue as coreLineRevenue,
  mulDivRound,
  refundedCost,
  refundedRevenue,
} from '@bikri/core';
import type { BikriDb, SyncedRow } from '@bikri/db';
import type { Table } from 'dexie';

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

/** 07 §1: profit uses revenue ex-tax and ex-rounding. */
export function lineRevenue(line: SyncedRow, taxInclusive: boolean): number {
  return coreLineRevenue(
    n(line.net),
    n(line.bill_discount_alloc),
    n(line.tax_alloc),
    taxInclusive,
  );
}

function inRange(row: SyncedRow, range: ReportRange): boolean {
  const date = String(row.business_date);
  if (date < range.from || date > range.to) return false;
  return range.deviceId === undefined || row.device_id === range.deviceId;
}

const ID_CHUNK = 100;

/** Rows whose key is in `ids`; one table scan beats hundreds of index lookups. */
async function rowsForIds<T>(
  table: Table<T, string>,
  index: string,
  keyOf: (row: T) => string,
  ids: readonly string[],
): Promise<T[]> {
  if (ids.length === 0) return [];
  if (ids.length > ID_CHUNK) {
    const wanted = new Set(ids);
    return (await table.toArray()).filter((row) => wanted.has(keyOf(row)));
  }
  const out: T[] = [];
  for (let at = 0; at < ids.length; at += ID_CHUNK) {
    const chunk = ids.slice(at, at + ID_CHUNK);
    if (chunk.length > 0)
      out.push(...(await table.where(index).anyOf(chunk).toArray()));
  }
  return out;
}

async function byIds<T extends { id: string }>(
  table: Table<T, string>,
  ids: readonly string[],
): Promise<Map<string, T>> {
  const out = new Map<string, T>();
  const unique = [...new Set(ids)];
  if (unique.length > ID_CHUNK) {
    const wanted = new Set(unique);
    for (const row of await table.toArray())
      if (wanted.has(row.id)) out.set(row.id, row);
    return out;
  }
  for (let at = 0; at < unique.length; at += ID_CHUNK) {
    for (const row of await table.bulkGet(unique.slice(at, at + ID_CHUNK))) {
      if (row) out.set(row.id, row);
    }
  }
  return out;
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
  const saleById = new Map(sales.map((sale) => [String(sale.id), sale]));
  const saleLines = await rowsForIds(
    db.sale_lines,
    'sale_id',
    (line: SyncedRow) => String(line.sale_id),
    [...saleById.keys()],
  );
  for (const sale of sales) {
    out.sold += n(sale.total);
    out.udhaarGiven += n(sale.udhaar_amount);
  }
  for (const line of saleLines) {
    const sale = saleById.get(String(line.sale_id));
    if (!sale) continue;
    out.grossProfit +=
      lineRevenue(line, sale.tax_inclusive === 1) -
      mulDivRound(n(line.qty_milli), n(line.unit_cost_snapshot), 1000);
  }
  if (refunds.length > 0) {
    const refundById = new Map(
      refunds.map((refund) => [String(refund.id), refund]),
    );
    const refundLines = await rowsForIds(
      db.refund_lines,
      'refund_id',
      (line: SyncedRow) => String(line.refund_id),
      [...refundById.keys()],
    );
    const touchedLineIds = [
      ...new Set(refundLines.map((line) => String(line.sale_line_id))),
    ];
    const originalLines = await byIds<SyncedRow>(db.sale_lines, touchedLineIds);
    const originalSales = await byIds<SyncedRow>(
      db.sales,
      [
        ...new Set(
          [...originalLines.values()].map((line) => String(line.sale_id)),
        ),
      ].filter((id) => !saleById.has(id)),
    );
    // Every refund of a touched line, including refunds outside this range, decides the
    // cumulative quantity each refund returns (07 §6).
    const allLineRefunds = await rowsForIds(
      db.refund_lines,
      'sale_line_id',
      (line: SyncedRow) => String(line.sale_line_id),
      touchedLineIds,
    );
    const previousByRefundLine = new Map<string, number>();
    const byLine = new Map<string, SyncedRow[]>();
    for (const line of allLineRefunds) {
      const key = String(line.sale_line_id);
      const list = byLine.get(key) ?? [];
      list.push(line);
      byLine.set(key, list);
    }
    for (const list of byLine.values()) {
      list.sort(
        (a, b) =>
          n(a.created_at) - n(b.created_at) ||
          String(a.id).localeCompare(String(b.id)),
      );
      let previous = 0;
      for (const line of list) {
        previousByRefundLine.set(String(line.id), previous);
        previous += n(line.qty_milli);
      }
    }
    for (const refund of refunds) {
      out.sold -= n(refund.amount) + n(refund.udhaar_part);
      out.udhaarGiven -= n(refund.udhaar_part);
    }
    for (const rl of refundLines) {
      const line = originalLines.get(String(rl.sale_line_id));
      if (!line) continue;
      const sale =
        saleById.get(String(line.sale_id)) ??
        originalSales.get(String(line.sale_id));
      const prev = previousByRefundLine.get(String(rl.id)) ?? 0;
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
