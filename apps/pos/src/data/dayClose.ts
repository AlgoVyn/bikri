import {
  businessDate,
  computeDayClose,
  type DayCloseInput,
  newId,
} from '@bikri/core';
import type { BikriDb, SyncedRow } from '@bikri/db';
import type { DayCloseReceipt } from '@bikri/printer';
import type { Table } from 'dexie';
import { csvCell, rupeesCsv2 } from '../lib/csv.ts';
import type { TableSource } from './caches.ts';
import type { LedgerContext } from './products.ts';
import { writeAction } from './write.ts';

const n = (v: unknown): number => Number(v ?? 0);
const TEN_MIN = 10 * 60 * 1000;

export type DayCloseComponents = Omit<DayCloseInput, 'counted_cash'> & {
  cardTotal: number;
  bankTotal: number;
  udhaarGiven: number;
  bills: number;
  refunds: number;
};

export type DayCloseData = {
  components: DayCloseComponents;
  deviceId: string;
  periodStart: number;
  periodEnd: number;
  openingCash: number;
  firstClose: boolean;
  recentClose: SyncedRow | null;
  expectedCash: number;
};

async function sumPayments(
  src: TableSource,
  deviceId: string,
  start: number,
  now: number,
): Promise<SyncedRow[]> {
  return (src.table('payments') as Table<SyncedRow>)
    .where('[device_id+created_at]')
    .between([deviceId, start], [deviceId, now], false, true)
    .toArray();
}

export type DayCloseInfo = {
  cardTotal: number;
  bankTotal: number;
  udhaarGiven: number;
  bills: number;
  refunds: number;
};

/** Informational totals for a closed period (card, bank, udhaar, bills, refunds). */
export async function dayCloseInfo(
  src: TableSource,
  deviceId: string,
  start: number,
  end: number,
): Promise<DayCloseInfo> {
  const payments = await sumPayments(src, deviceId, start, end);
  const sales = (
    await (src.table('sales') as Table<SyncedRow>)
      .where('created_at')
      .between(start, end, false, true)
      .toArray()
  ).filter((s) => s.device_id === deviceId);
  const refunds = await (src.table('refunds') as Table<SyncedRow>)
    .where('[device_id+created_at]')
    .between([deviceId, start], [deviceId, end], false, true)
    .toArray();
  const saleSum = (method: string) =>
    payments
      .filter(
        (p) =>
          p.direction === 'in' && p.purpose === 'sale' && p.method === method,
      )
      .reduce((sum, p) => sum + n(p.amount), 0);
  return {
    cardTotal: saleSum('card'),
    bankTotal: saleSum('bank_wallet'),
    udhaarGiven: sales.reduce((sum, s) => sum + n(s.udhaar_amount), 0),
    bills: sales.filter((s) => s.status !== 'void').length,
    refunds: refunds.length,
  };
}

/** Drawer figures for one device (07 §8, screens/15). */
export async function dayCloseData(
  src: TableSource,
  deviceId: string,
  now = Date.now(),
  openingOverride?: number,
): Promise<DayCloseData> {
  const closes = (
    await (src.table('day_closes') as Table<SyncedRow>)
      .where('[device_id+period_end]')
      .between([deviceId, 0], [deviceId, now])
      .toArray()
  ).sort((a, b) => n(a.period_end) - n(b.period_end));
  const last = closes.at(-1) ?? null;
  const deviceRow = await (src.table('devices') as Table<SyncedRow>).get(
    deviceId,
  );
  const periodStart = last ? n(last.period_end) : n(deviceRow?.created_at);
  const payments = await sumPayments(src, deviceId, periodStart, now);
  const cash = payments.filter((p) => p.method === 'cash');
  const pick = (direction: string, purposes: string[], rows = cash) =>
    rows
      .filter(
        (p) =>
          p.direction === direction && purposes.includes(String(p.purpose)),
      )
      .reduce((sum, p) => sum + n(p.amount), 0);

  const moves = (
    await (src.table('cash_moves') as Table<SyncedRow>)
      .where('[device_id+created_at]')
      .between([deviceId, periodStart], [deviceId, now], false, true)
      .toArray()
  ).filter((m) => m.kind === 'pay_in' || m.kind === 'pay_out');
  const expenses = (
    await (src.table('expenses') as Table<SyncedRow>)
      .where('[device_id+created_at]')
      .between([deviceId, periodStart], [deviceId, now], false, true)
      .toArray()
  ).filter((e) => e.method === 'cash');
  const cashExpenses = expenses.reduce(
    (sum, row) => sum + n(row.amount) * (row.reverses_id ? -1 : 1),
    0,
  );
  const info = await dayCloseInfo(src, deviceId, periodStart, now);
  const components: DayCloseComponents = {
    opening_cash: last ? n(last.counted_cash) : (openingOverride ?? 0),
    cash_sales: pick('in', ['sale']),
    udhaar_cash_in: pick('in', ['customer_payment']),
    pay_ins: moves
      .filter((m) => m.kind === 'pay_in')
      .reduce((sum, m) => sum + n(m.amount), 0),
    supplier_cash_in: pick('in', ['supplier_refund']),
    cash_refunds: pick('out', ['refund', 'void']),
    cash_expenses: cashExpenses,
    supplier_cash_out: pick('out', ['supplier_payment', 'purchase_paid_now']),
    pay_outs: moves
      .filter((m) => m.kind === 'pay_out')
      .reduce((sum, m) => sum + n(m.amount), 0),
    cardTotal: info.cardTotal,
    bankTotal: info.bankTotal,
    udhaarGiven: info.udhaarGiven,
    bills: info.bills,
    refunds: info.refunds,
  };
  const expected = computeDayClose({ ...components, counted_cash: 0 });
  return {
    components,
    deviceId,
    periodStart,
    periodEnd: now,
    openingCash: components.opening_cash,
    firstClose: !last,
    recentClose: last && now - n(last.created_at) < TEN_MIN ? last : null,
    expectedCash: expected.expected_cash,
  };
}

export type CloseDayInput = {
  dayCloseId: string;
  countedCash: number;
  denominations?: Record<string, number> | null;
  note?: string;
  /** First close only: opening float. */
  openingCash?: number;
};

export type CloseDayOptions = {
  now?: number;
  print?: boolean;
};

/** Close recipe: one `day_closes` row plus the difference audit (screens/15). */
export async function closeDay(
  db: BikriDb,
  input: CloseDayInput,
  ctx: LedgerContext,
  options: CloseDayOptions = {},
): Promise<SyncedRow> {
  const existing = await db.day_closes.get(input.dayCloseId);
  if (existing) return existing;
  if (!Number.isSafeInteger(input.countedCash) || input.countedCash < 0)
    throw new RangeError('counted cash must be non-negative');
  const now = options.now ?? Date.now();
  const row = await writeAction(
    db,
    async (w) => {
      const data = await dayCloseData(w, ctx.device_id, now, input.openingCash);
      // Two tabs can prepare the same period; the second must return the first close,
      // not open a second drawer period with the same opening float.
      const duplicate = (
        await (w.table('day_closes') as Table<SyncedRow>)
          .where('[device_id+period_end]')
          .between(
            [ctx.device_id, data.periodStart],
            [ctx.device_id, now],
            true,
            true,
          )
          .toArray()
      ).find((row) => n(row.period_start) === data.periodStart);
      if (duplicate) return duplicate;
      const result = computeDayClose({
        ...data.components,
        counted_cash: input.countedCash,
      });
      const note = (input.note ?? '').trim().slice(0, 200);
      if (Math.abs(result.difference) >= 10_000 && note === '')
        throw new RangeError(
          'note required for a difference of Rs 100 or more',
        );
      const shop = await (
        w.table('shop') as Table<{ id: string; timezone?: string }>
      ).get('shop');
      const tz = String(shop?.timezone ?? 'Asia/Karachi') || 'Asia/Karachi';
      const dayClose: SyncedRow = {
        id: input.dayCloseId,
        device_id: ctx.device_id,
        branch_id: ctx.branch_id,
        staff_id: ctx.staff_id,
        business_date: businessDate(now, tz),
        period_start: data.periodStart,
        period_end: now,
        opening_cash: result.opening_cash,
        cash_sales: result.cash_sales,
        udhaar_cash_in: result.udhaar_cash_in,
        pay_ins: result.pay_ins,
        supplier_cash_in: result.supplier_cash_in,
        cash_refunds: result.cash_refunds,
        cash_expenses: result.cash_expenses,
        supplier_cash_out: result.supplier_cash_out,
        pay_outs: result.pay_outs,
        expected_cash: result.expected_cash,
        counted_cash: result.counted_cash,
        difference: result.difference,
        denominations_json: input.denominations
          ? JSON.stringify(input.denominations)
          : null,
        note,
        created_at: now,
      };
      await w.insert('day_closes', dayClose);
      if (Math.abs(result.difference) >= 10_000)
        await w.insert('audit_log', {
          id: newId(now),
          action: 'day_close_difference',
          entity: 'day_closes',
          entity_id: input.dayCloseId,
          before_json: null,
          after_json: JSON.stringify({
            difference: result.difference,
            note,
          }),
          device_id: ctx.device_id,
          staff_id: ctx.staff_id,
          created_at: now,
        });
      return dayClose;
    },
    { now, actor: ctx.staff_id },
  );
  if (options.print !== false)
    await queueDayClosePrint(db, String(row.id), { now });
  return row;
}

/** Queues the Z-report; the print service builds it from the stored close. */
export async function queueDayClosePrint(
  db: BikriDb,
  dayCloseId: string,
  options: { now?: number } = {},
): Promise<string> {
  const now = options.now ?? Date.now();
  const id = newId(now);
  await db.print_jobs.put({
    id,
    day_close_id: dayCloseId,
    kind: 'day_close',
    status: 'queued',
    created_at: now,
  });
  return id;
}

/** CSV of one closed drawer; amounts in rupees with two decimals (screens/15). */
export function dayCloseCsv(
  receipt: DayCloseReceipt,
  businessDateValue: string,
  timeZone: string,
): string {
  const when = (at: number): string =>
    new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    })
      .format(at)
      .replace(', ', ' ');
  const header = [
    'date',
    'device',
    'cashier',
    'period_start',
    'period_end',
    'opening',
    'cash_sales',
    'udhaar_in',
    'pay_ins',
    'supplier_in',
    'refunds',
    'expenses',
    'supplier_out',
    'pay_outs',
    'expected',
    'counted',
    'difference',
    'card',
    'bank',
    'udhaar_given',
    'bills',
    'refunds_count',
    'note',
  ];
  const row = [
    businessDateValue,
    receipt.deviceName,
    receipt.staffName ?? '',
    when(receipt.periodStart),
    when(receipt.periodEnd),
    rupeesCsv2(receipt.openingCash),
    rupeesCsv2(receipt.cashSales),
    rupeesCsv2(receipt.udhaarCashIn),
    rupeesCsv2(receipt.payIns),
    rupeesCsv2(receipt.supplierCashIn),
    rupeesCsv2(receipt.cashRefunds),
    rupeesCsv2(receipt.cashExpenses),
    rupeesCsv2(receipt.supplierCashOut),
    rupeesCsv2(receipt.payOuts),
    rupeesCsv2(receipt.expectedCash),
    rupeesCsv2(receipt.countedCash),
    rupeesCsv2(receipt.difference),
    rupeesCsv2(receipt.cardTotal),
    rupeesCsv2(receipt.bankTotal),
    rupeesCsv2(receipt.udhaarGiven),
    String(receipt.bills),
    String(receipt.refunds),
    receipt.note,
  ];
  return `${[header.join(',')]
    .concat([row.map(csvCell).join(',')])
    .join('\r\n')}\r\n`;
}
