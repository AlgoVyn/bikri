import { describe, expect, it } from 'vitest';
import { statementBlocks } from './creditPrint.ts';

describe('customer statement print blocks', () => {
  it('prints one signed amount per entry and the ending balance as total', () => {
    const blocks = statementBlocks({
      shopName: 'Supreme Electronics',
      customerName: 'Ali',
      phone: '03001234567',
      balance: 125000,
      from: null,
      to: null,
      rows: [
        {
          date: '13 Nov 2026',
          description: 'Bill INV-1',
          debit: 150000,
          credit: 0,
          balance: 150000,
        },
        {
          date: '13 Nov 2026',
          description: 'Payment received',
          debit: 0,
          credit: 25000,
          balance: 125000,
        },
      ],
      openingBalance: 0,
      lang: 'en',
      labels: {
        title: 'Statement',
        date: 'Date',
        description: 'Description',
        debit: 'Debit',
        credit: 'Credit',
        balance: 'Balance',
        opening: 'Opening',
        total: 'Total',
        asOf: 'As of 13 Nov 2026',
      },
    });
    expect(blocks[0]).toEqual({ t: 'logo' });
    expect(blocks.at(-2)).toEqual({ t: 'feed', lines: 3 });
    expect(blocks.at(-1)).toEqual({ t: 'cut' });
    expect(blocks).toContainEqual({
      t: 'pair',
      left: '13 Nov 2026 · Bill INV-1',
      right: '+Rs 1,500',
    });
    expect(blocks).toContainEqual({
      t: 'pair',
      left: '13 Nov 2026 · Payment received',
      right: '-Rs 250',
    });
    expect(blocks).not.toContainEqual(
      expect.objectContaining({ t: 'pair', left: 'Debit' }),
    );
    expect(blocks).not.toContainEqual(
      expect.objectContaining({ t: 'pair', left: 'Credit' }),
    );
    expect(blocks).toContainEqual({
      t: 'pair',
      left: 'Total',
      right: 'Rs 1,250',
      bold: true,
    });
  });
});
