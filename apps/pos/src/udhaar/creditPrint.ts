import type { BikriDb } from '@bikri/db';
import type { Block } from '@bikri/printer';
import { formatShopMoney } from '../lib/money.ts';
import { browserPrintDeps } from '../print/printDeps.ts';
import { printBlocks, readPrinter } from '../print/printService.ts';
import { PrintError } from '../print/transports.ts';
import type { StatementFileMeta } from './statementFile.ts';

function signed(paisa: number): string {
  if (paisa === 0) return formatShopMoney(0);
  return `${paisa > 0 ? '+' : '-'}${formatShopMoney(Math.abs(paisa))}`;
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
      right: signed(meta.openingBalance),
      size: 'small',
    });
  }
  for (const row of meta.rows) {
    const delta = row.debit - row.credit;
    blocks.push({
      t: 'pair',
      left: `${row.date} · ${row.description}`,
      right: signed(delta),
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
