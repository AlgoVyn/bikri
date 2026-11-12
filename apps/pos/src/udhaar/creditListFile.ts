import type { TFunction } from 'i18next';
import type { CustomerList } from '../data/udhaar.ts';
import { formatShopMoney } from '../lib/money.ts';
import { ageLabel, dateText } from './format.ts';

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

function esc(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/gu, (ch) => ESCAPES[ch] ?? ch);
}

export type CreditListPrintInput = {
  shopName: string;
  rows: CustomerList['rows'];
  totalOwed: number;
  owingCount: number;
  tz: string;
  lang: string;
  t: TFunction;
  now?: number;
};

/** A4 customer-credit list for the OS print dialog. */
export function creditListHtml(input: CreditListPrintInput): string {
  const { rows, t, lang, tz, now = Date.now() } = input;
  const dir = lang === 'ur' ? 'rtl' : 'ltr';
  const locale = lang === 'ur' ? 'ur-PK' : 'en-PK';
  const generated = new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: tz,
  }).format(new Date(now));
  const body = rows
    .map((row) => {
      const customer = row.customer;
      const phone = String(customer.phone ?? '').trim();
      const limit =
        customer.credit_limit === null || customer.credit_limit === undefined
          ? t('office.udhaar.no_limit')
          : formatShopMoney(Number(customer.credit_limit));
      const promise = row.promise
        ? dateText(String(row.promise.promised_on), lang, tz)
        : '—';
      return `<tr>
        <td>${esc(customer.name)}</td>
        <td dir="ltr">${esc(phone || '—')}</td>
        <td class="num">${esc(formatShopMoney(row.balance))}</td>
        <td>${esc(ageLabel(t, row.oldestUnpaidAt, now) || '—')}</td>
        <td class="num">${esc(limit)}</td>
        <td>${esc(promise)}</td>
      </tr>`;
    })
    .join('');
  return `<!doctype html>
<html dir="${dir}" lang="${lang}">
<head>
<meta charset="utf-8">
<title>${esc(t('office.udhaar.print_title'))} — ${esc(input.shopName)}</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; color: #111827; font: 10px/1.45 'Inter', 'Noto Naskh Arabic UI', sans-serif; }
  h1 { margin: 0 0 1mm; font-size: 18px; }
  .muted { color: #4b5563; }
  .meta { display: flex; justify-content: space-between; gap: 8mm; margin-bottom: 5mm; }
  .totals { margin: 0 0 4mm; }
  .totals strong { font-size: 13px; }
  table { width: 100%; border-collapse: collapse; }
  thead { display: table-header-group; }
  th, td { padding: 1.6mm 1.2mm; border-bottom: 0.2mm solid #d1d5db; text-align: start; vertical-align: top; }
  th { background: #f3f4f6; font-weight: 600; white-space: nowrap; }
  tr { break-inside: avoid; page-break-inside: avoid; }
  .num { white-space: nowrap; }
  .empty { padding: 10mm 0; text-align: center; color: #6b7280; }
  footer { margin-top: 6mm; color: #6b7280; font-size: 9px; }
</style>
</head>
<body>
  <header>
    <h1>${esc(input.shopName)}</h1>
    <div class="meta">
      <div><strong>${esc(t('office.udhaar.print_title'))}</strong></div>
      <div class="muted">${esc(t('office.udhaar.print_generated', { date: generated }))}</div>
    </div>
  </header>
  <p class="totals">
    ${esc(t('office.udhaar.total_owed'))}: <strong>${esc(formatShopMoney(input.totalOwed))}</strong>
    · ${esc(t('office.udhaar.customers_owing'))}: <strong>${input.owingCount}</strong>
  </p>
  ${
    rows.length === 0
      ? `<p class="empty">${esc(t('office.udhaar.no_customers'))}</p>`
      : `<table>
    <thead><tr>
      <th>${esc(t('office.udhaar.col_customer'))}</th>
      <th>${esc(t('office.udhaar.phone'))}</th>
      <th>${esc(t('office.udhaar.balance'))}</th>
      <th>${esc(t('office.udhaar.sort_oldest'))}</th>
      <th>${esc(t('office.udhaar.credit_limit'))}</th>
      <th>${esc(t('office.udhaar.promise'))}</th>
    </tr></thead>
    <tbody>${body}</tbody>
  </table>`
  }
  <footer>${esc(t('office.udhaar.print_footer'))}</footer>
</body>
</html>`;
}
