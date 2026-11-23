import type { BikriDb } from '@bikri/db';
import { type Block, formatReceiptMoney, hasNonAscii } from '@bikri/printer';
import { receiptPaper } from '../data/receipt.ts';
import type { StatementItem } from '../data/udhaar.ts';
import { qtyCsv } from '../lib/csv.ts';
import { shopGrouping } from '../lib/money.ts';
import { browserPrintDeps } from '../print/printDeps.ts';
import { printBlocks, readPrinter } from '../print/printService.ts';
import { PrintError } from '../print/transports.ts';
import type { StatementFileMeta } from './statementFile.ts';

/** PC437-safe money: ASCII `-`, grouped like the shop setting (06 §4). */
function money(paisa: number): string {
  return formatReceiptMoney(paisa, shopGrouping());
}

function signed(paisa: number): string {
  if (paisa === 0) return money(0);
  return `${paisa > 0 ? '+' : '-'}${money(Math.abs(paisa))}`;
}

/** Remove the space in `Rs 500` so unit price and line total fit one thermal line. */
function compactMoney(paisa: number): string {
  return money(paisa).replace(/^(-?)Rs /u, '$1Rs');
}

/**
 * One compact detail line for a thermal statement:
 * `  Name ×2 @Rs450 =Rs900`. The name is truncated so the line never wraps.
 * Small (Font B) gives 4/3 columns; Urdu lines wrap at 60% of that width.
 */
function statementItemLine(item: StatementItem, charsPerLine: number): string {
  // Keep this line ASCII: `hasNonAscii` would make the printer wrap it at 60%
  // of the column width even for an English product name.
  const suffix = ` x${qtyCsv(item.qtyMilli)} @${compactMoney(item.unitPrice)} =${compactMoney(item.amount)}`;
  const capacity = Math.floor((charsPerLine * 4) / 3);
  const width = hasNonAscii(item.name) ? Math.floor(capacity * 0.6) : capacity;
  const room = Math.max(1, width - 2 - suffix.length);
  // Code points, never UTF-16 units: slicing an emoji in half breaks printing.
  const chars = Array.from(item.name);
  const name =
    chars.length > room
      ? `${chars
          .slice(0, Math.max(0, room - 3))
          .join('')
          .trimEnd()}...`
      : item.name;
  return `  ${name}${suffix}`;
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

/** Thermal receipt blocks for one customer statement. */
export function statementBlocks(
  meta: StatementFileMeta,
  charsPerLine = 48,
): Block[] {
  const closingBalance = meta.rows.at(-1)?.balance ?? meta.openingBalance;
  const blocks: Block[] = [];
  if (meta.showLogo !== false) blocks.push({ t: 'logo' });
  if (meta.showShopName !== false && meta.shopName.trim().length > 0)
    blocks.push({
      t: 'text',
      text: meta.shopName,
      align: 'center',
      bold: true,
    });
  blocks.push(
    { t: 'text', text: meta.labels.title, align: 'center' },
    {
      t: 'text',
      text: [meta.customerName, meta.phone].filter(Boolean).join(' - '),
      align: 'center',
      size: 'small',
    },
    {
      t: 'pair',
      left: meta.labels.balance,
      right: money(closingBalance),
      bold: true,
    },
    { t: 'text', text: meta.labels.asOf, align: 'center', size: 'small' },
    { t: 'rule', char: '-' },
  );
  if (meta.openingBalance !== 0) {
    blocks.push({
      t: 'pair',
      left: meta.labels.opening,
      right: signed(meta.openingBalance),
      size: 'small',
    });
  }
  for (const row of meta.rows) {
    const delta = row.debit - row.credit;
    blocks.push({
      t: 'pair',
      left: `${row.dateShort ?? row.date} - ${row.descriptionShort ?? row.description}`,
      right: signed(delta),
    });
    for (const item of row.items ?? []) {
      blocks.push({
        t: 'text',
        text: statementItemLine(item, charsPerLine),
        size: 'small',
      });
    }
  }
  blocks.push({ t: 'rule', char: '=' });
  blocks.push({
    t: 'pair',
    left: meta.labels.total,
    right: money(closingBalance),
    bold: true,
  });
  return finish(blocks);
}

export async function printCustomerStatement(
  db: BikriDb,
  meta: StatementFileMeta,
): Promise<void> {
  const current = await printer(db);
  const paper = receiptPaper(current);
  await printBlocks(
    db,
    statementBlocks(meta, paper.charsPerLine),
    current,
    browserPrintDeps(),
    1,
    undefined,
    undefined,
    // A statement is a summary document, not a receipt: keep the mark modest.
    { logoWidthPct: 0.3, logoMaxHeight: 96 },
  );
}
