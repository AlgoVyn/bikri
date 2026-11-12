import type { BikriDb } from '@bikri/db';
import type { Block } from '@bikri/printer';
import type { TFunction } from 'i18next';
import type { CustomerList } from '../data/udhaar.ts';
import { formatShopMoney } from '../lib/money.ts';
import { browserPrintDeps } from '../print/printDeps.ts';
import { printBlocks, readPrinter } from '../print/printService.ts';
import { PrintError } from '../print/transports.ts';
import { ageLabel, dateText } from './format.ts';
import type { StatementFileMeta } from './statementFile.ts';

function generated(now: number, lang: string, tz: string): string {
  return new Intl.DateTimeFormat(lang === 'ur' ? 'ur-PK' : 'en-PK', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: tz,
  }).format(new Date(now));
}

function finish(blocks: Block[]): Block[] {
  blocks.push({ t: 'feed', lines: 3 });
  blocks.push({ t: 'cut' });
  return blocks;
}

async function printer(db: BikriDb) {
  const current = await readPrinter(db);
  if (!current?.transport) throw new PrintError('NO_PRINTER');
  return current;
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

/** Thermal receipt blocks for the filtered customer-credit list. */
export function creditListBlocks(input: CreditListPrintInput): Block[] {
  const { rows, t, lang, tz, now = Date.now() } = input;
  const blocks: Block[] = [
    { t: 'logo' },
    { t: 'text', text: input.shopName, align: 'center', bold: true },
    { t: 'text', text: t('office.udhaar.print_title'), align: 'center' },
    {
      t: 'text',
      text: t('office.udhaar.print_generated', {
        date: generated(now, lang, tz),
      }),
      align: 'center',
      size: 'small',
    },
    { t: 'rule', char: '-' },
    {
      t: 'pair',
      left: t('office.udhaar.total_owed'),
      right: formatShopMoney(input.totalOwed),
      bold: true,
    },
    {
      t: 'pair',
      left: t('office.udhaar.customers_owing'),
      right: String(input.owingCount),
    },
    { t: 'rule', char: '-' },
  ];
  for (const row of rows) {
    const customer = row.customer;
    const phone = String(customer.phone ?? '').trim();
    const age = ageLabel(t, row.oldestUnpaidAt, now);
    const limit =
      customer.credit_limit === null || customer.credit_limit === undefined
        ? ''
        : `${t('office.udhaar.credit_limit')}: ${formatShopMoney(Number(customer.credit_limit))}`;
    const promise = row.promise
      ? `${t('office.udhaar.promise')}: ${dateText(String(row.promise.promised_on), lang, tz)}`
      : '';
    const detail = [phone, age, limit, promise].filter(Boolean).join(' · ');
    blocks.push({ t: 'text', text: String(customer.name), bold: true });
    blocks.push({
      t: 'pair',
      left: detail,
      right: formatShopMoney(row.balance),
    });
  }
  blocks.push({ t: 'rule', char: '-' });
  blocks.push({
    t: 'text',
    text: t('office.udhaar.print_footer'),
    align: 'center',
    size: 'small',
  });
  return finish(blocks);
}

export async function printCreditList(
  db: BikriDb,
  input: CreditListPrintInput,
): Promise<void> {
  await printBlocks(
    db,
    creditListBlocks(input),
    await printer(db),
    browserPrintDeps(),
    1,
  );
}

/** Thermal receipt blocks for one customer statement. */
export function statementBlocks(meta: StatementFileMeta): Block[] {
  const blocks: Block[] = [
    { t: 'logo' },
    { t: 'text', text: meta.shopName, align: 'center', bold: true },
    { t: 'text', text: meta.labels.title, align: 'center' },
    {
      t: 'text',
      text: [meta.customerName, meta.phone].filter(Boolean).join(' · '),
      align: 'center',
      size: 'small',
    },
    {
      t: 'pair',
      left: meta.labels.balance,
      right: formatShopMoney(meta.balance),
      bold: true,
    },
    { t: 'text', text: meta.labels.asOf, align: 'center', size: 'small' },
    { t: 'rule', char: '-' },
  ];
  if (meta.openingBalance !== 0) {
    blocks.push({
      t: 'pair',
      left: meta.labels.opening,
      right: formatShopMoney(meta.openingBalance),
    });
  }
  for (const row of meta.rows) {
    blocks.push({
      t: 'text',
      text: `${row.date} · ${row.description}`,
      size: 'small',
    });
    if (row.debit !== 0) {
      blocks.push({
        t: 'pair',
        left: meta.labels.debit,
        right: formatShopMoney(row.debit),
      });
    }
    if (row.credit !== 0) {
      blocks.push({
        t: 'pair',
        left: meta.labels.credit,
        right: formatShopMoney(row.credit),
      });
    }
    blocks.push({
      t: 'pair',
      left: meta.labels.balance,
      right: formatShopMoney(row.balance),
      size: 'small',
    });
  }
  blocks.push({ t: 'rule', char: '=' });
  blocks.push({
    t: 'pair',
    left: meta.labels.total,
    right: formatShopMoney(meta.balance),
    bold: true,
  });
  return finish(blocks);
}

export async function printCustomerStatement(
  db: BikriDb,
  meta: StatementFileMeta,
): Promise<void> {
  await printBlocks(
    db,
    statementBlocks(meta),
    await printer(db),
    browserPrintDeps(),
    1,
  );
}
