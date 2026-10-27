import { mulDivRound } from '@bikri/core';
import { csvCell, qtyCsv, rupeesCsv2 } from '../lib/csv.ts';
import type { ReportBundle } from './reportBundle.ts';

export type ReportTab =
  | 'summary'
  | 'products'
  | 'stock'
  | 'udhaar'
  | 'staff'
  | 'day_closes'
  | 'expenses';

type CsvOptions = { includeCost: boolean };

const total = (values: readonly number[]): number =>
  values.reduce((sum, value) => sum + value, 0);

function percent(bp: number): string {
  return (bp / 100).toFixed(2);
}

function margin(profit: number, revenue: number): string {
  return revenue > 0 ? percent(mulDivRound(profit, 10000, revenue)) : '0.00';
}

function lines(header: readonly string[], rows: readonly string[][]): string {
  return [header.join(',')]
    .concat(rows.map((row) => row.join(',')))
    .join('\r\n');
}

/** CSV for the current Reports tab; amounts are always rupees with two decimals (AC 6). */
export function reportCsv(
  tab: ReportTab,
  bundle: ReportBundle,
  options: CsvOptions = { includeCost: true },
): string {
  const money = rupeesCsv2;
  if (tab === 'summary') {
    const header = [
      'date',
      'bills',
      'sold',
      ...(options.includeCost ? ['gross_profit'] : []),
      'expenses',
      ...(options.includeCost ? ['net_profit'] : []),
      'udhaar_given',
      'udhaar_received',
      'tax_collected',
      'cash',
      'card',
      'bank_wallet',
      'udhaar',
    ];
    const rows = bundle.summary.daily.map((day) => [
      String(day.date),
      String(day.bills),
      money(day.sold),
      ...(options.includeCost ? [money(day.grossProfit)] : []),
      money(day.expenses),
      ...(options.includeCost ? [money(day.netProfit)] : []),
      money(day.udhaarGiven),
      money(day.udhaarReceived),
      money(day.tax),
      money(day.mix.cash),
      money(day.mix.card),
      money(day.mix.bank_wallet),
      money(day.mix.udhaar),
    ]);
    const summary = bundle.summary;
    rows.push([
      'TOTAL',
      String(summary.bills),
      money(summary.sold),
      ...(options.includeCost ? [money(summary.grossProfit)] : []),
      money(summary.expenses),
      ...(options.includeCost ? [money(summary.netProfit)] : []),
      money(summary.udhaarGiven),
      money(summary.udhaarReceived),
      money(summary.tax),
      money(summary.paymentMix.cash),
      money(summary.paymentMix.card),
      money(summary.paymentMix.bank_wallet),
      money(summary.paymentMix.udhaar),
    ]);
    return lines(header, rows);
  }

  if (tab === 'products') {
    if (!options.includeCost)
      return lines(
        ['product', 'sku', 'qty_sold', 'revenue'],
        bundle.products.rows.map((row) => [
          csvCell(row.name),
          csvCell(row.sku),
          qtyCsv(row.qtyMilli),
          money(row.revenue),
        ]),
      );
    return lines(
      ['product', 'sku', 'qty_sold', 'revenue', 'cost', 'profit', 'margin_pct'],
      bundle.products.rows.map((row) => [
        csvCell(row.name),
        csvCell(row.sku),
        qtyCsv(row.qtyMilli),
        money(row.revenue),
        money(row.cost),
        money(row.profit),
        margin(row.profit, row.revenue),
      ]),
    );
  }

  if (tab === 'stock') {
    const header = options.includeCost
      ? [
          'product',
          'sku',
          'on_hand',
          'min_stock',
          'avg_cost',
          'stock_value',
          'status',
        ]
      : ['product', 'sku', 'on_hand', 'min_stock', 'status'];
    return lines(
      header,
      bundle.stock.items.map((row) =>
        options.includeCost
          ? [
              csvCell(String(row.product.name_en)),
              csvCell(String(row.product.sku)),
              qtyCsv(row.onHand),
              qtyCsv(Number(row.product.min_stock_milli ?? 0)),
              money(Number(row.product.avg_cost ?? 0)),
              money(row.value),
              row.status,
            ]
          : [
              csvCell(String(row.product.name_en)),
              csvCell(String(row.product.sku)),
              qtyCsv(row.onHand),
              qtyCsv(Number(row.product.min_stock_milli ?? 0)),
              row.status,
            ],
      ),
    );
  }

  if (tab === 'udhaar') {
    return lines(
      ['bucket', 'name', 'phone', 'balance', 'age_days', 'promise_date'],
      bundle.udhaar.rows.map((row) => [
        row.bucket,
        csvCell(String(row.customer.name)),
        csvCell(String(row.customer.phone ?? '')),
        money(row.balance),
        String(row.ageDays),
        row.promiseDate ?? '',
      ]),
    );
  }

  if (tab === 'staff') {
    return lines(
      [
        'cashier',
        'bills',
        'sold',
        'discounts',
        'refunds',
        'refunded_amount',
        'voids',
        'voided_amount',
        'net_sold',
      ],
      bundle.staff.map((row) => [
        csvCell(row.name),
        String(row.bills),
        money(row.sold),
        money(row.discounts),
        String(row.refunds),
        money(row.refunded),
        String(row.voids),
        money(row.voided),
        money(row.netSold),
      ]),
    );
  }

  if (tab === 'day_closes') {
    return lines(
      [
        'date',
        'device',
        'cashier',
        'expected',
        'counted',
        'difference',
        'note',
      ],
      bundle.dayCloses.rows.map((row) => [
        String(row.close.business_date),
        csvCell(row.deviceName),
        csvCell(row.staffName),
        money(Number(row.close.expected_cash)),
        money(Number(row.close.counted_cash)),
        money(Number(row.close.difference)),
        csvCell(String(row.close.note ?? '')),
      ]),
    );
  }

  return lines(
    ['category', 'amount', 'share_pct'],
    bundle.expenses.rows.map((row) => [
      csvCell(String(row.category?.name_en ?? 'Uncategorized')),
      money(row.amount),
      percent(row.shareBp),
    ]),
  );
}

export function reportTotal(tab: ReportTab, bundle: ReportBundle): number {
  if (tab === 'summary') return bundle.summary.sold;
  if (tab === 'products')
    return total(bundle.products.rows.map((row) => row.revenue));
  if (tab === 'stock') return bundle.stock.value;
  if (tab === 'udhaar') return bundle.udhaar.totalOwed;
  if (tab === 'staff') return total(bundle.staff.map((row) => row.netSold));
  if (tab === 'day_closes') return bundle.dayCloses.difference;
  return bundle.expenses.total;
}
