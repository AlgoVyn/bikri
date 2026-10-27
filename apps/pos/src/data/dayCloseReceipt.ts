import type { BikriDb } from '@bikri/db';
import type { DayCloseReceipt } from '@bikri/printer';
import { dayCloseInfo } from './dayClose.ts';
import { receiptShop } from './receipt.ts';

/** The stored day close + the informational period totals for the Z-report. */
export async function loadDayCloseReceipt(
  db: BikriDb,
  dayCloseId: string,
): Promise<DayCloseReceipt | null> {
  const row = await db.day_closes.get(dayCloseId);
  if (!row) return null;
  const { shop } = await receiptShop(db);
  const staff = row.staff_id
    ? await db.staff.get(String(row.staff_id))
    : undefined;
  const device = row.device_id
    ? await db.devices.get(String(row.device_id))
    : undefined;
  const info = await dayCloseInfo(
    db,
    String(row.device_id),
    Number(row.period_start),
    Number(row.period_end),
  );
  let denominations: Record<string, number> | null = null;
  if (typeof row.denominations_json === 'string') {
    try {
      const parsed = JSON.parse(row.denominations_json) as unknown;
      if (parsed !== null && typeof parsed === 'object')
        denominations = parsed as Record<string, number>;
    } catch {
      denominations = null;
    }
  }
  return {
    shop,
    staffName: staff ? String(staff.name) : null,
    deviceName: device ? String(device.name ?? device.code ?? '') : '',
    periodStart: Number(row.period_start),
    periodEnd: Number(row.period_end),
    openingCash: Number(row.opening_cash),
    cashSales: Number(row.cash_sales),
    udhaarCashIn: Number(row.udhaar_cash_in),
    payIns: Number(row.pay_ins),
    supplierCashIn: Number(row.supplier_cash_in ?? 0),
    cashRefunds: Number(row.cash_refunds),
    cashExpenses: Number(row.cash_expenses),
    supplierCashOut: Number(row.supplier_cash_out),
    payOuts: Number(row.pay_outs),
    expectedCash: Number(row.expected_cash),
    countedCash: Number(row.counted_cash),
    difference: Number(row.difference),
    denominations,
    ...info,
    note: String(row.note ?? ''),
  };
}
