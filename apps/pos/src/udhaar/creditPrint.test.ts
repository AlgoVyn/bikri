import type { TFunction } from 'i18next';
import { describe, expect, it } from 'vitest';
import type { CustomerList } from '../data/udhaar.ts';
import { creditListBlocks, statementBlocks } from './creditPrint.ts';

const t = ((key: string, options?: { date?: string }) =>
  key === 'office.udhaar.print_generated'
    ? `As of ${options?.date ?? ''}`
    : key) as unknown as TFunction;

const rows = [
  {
    customer: {
      id: 'c1',
      name: 'Ali',
      phone: '03001234567',
      credit_limit: 500000,
    },
    balance: 125000,
    oldestUnpaidAt: Date.now() - 3 * 86_400_000,
    lastActivityAt: Date.now(),
    promise: { promised_on: '2026-11-20' },
  },
  {
    customer: { id: 'c2', name: 'Bilal', phone: '', credit_limit: null },
    balance: -25000,
    oldestUnpaidAt: null,
    lastActivityAt: Date.now(),
    promise: null,
  },
] as unknown as CustomerList['rows'];

describe('credit print blocks', () => {
  it('builds a thermal customer credit list ending in cut', () => {
    const blocks = creditListBlocks({
      shopName: 'Supreme Electronics',
      rows,
      totalOwed: 125000,
      owingCount: 1,
      tz: 'Asia/Karachi',
      lang: 'en',
      t,
      now: Date.parse('2026-11-13T10:00:00Z'),
    });
    expect(blocks[0]).toEqual({ t: 'logo' });
    expect(blocks.at(-2)).toEqual({ t: 'feed', lines: 3 });
    expect(blocks.at(-1)).toEqual({ t: 'cut' });
    expect(blocks).toContainEqual(
      expect.objectContaining({ t: 'text', text: 'Supreme Electronics' }),
    );
    expect(blocks).toContainEqual(
      expect.objectContaining({ t: 'text', text: 'Ali' }),
    );
    expect(
      blocks.some(
        (block) =>
          block.t === 'pair' &&
          block.left.includes('office.udhaar.credit_limit') &&
          block.right === 'Rs 1,250',
      ),
    ).toBe(true);
  });

  it('builds a thermal statement with debit, credit and balance rows', () => {
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
    expect(blocks.at(-1)).toEqual({ t: 'cut' });
    expect(blocks).toContainEqual({
      t: 'pair',
      left: 'Debit',
      right: 'Rs 1,500',
    });
    expect(blocks).toContainEqual({
      t: 'pair',
      left: 'Credit',
      right: 'Rs 250',
    });
    expect(blocks).toContainEqual({
      t: 'pair',
      left: 'Total',
      right: 'Rs 1,250',
      bold: true,
    });
  });
});
