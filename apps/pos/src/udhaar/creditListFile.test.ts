import type { TFunction } from 'i18next';
import { describe, expect, it } from 'vitest';
import type { CustomerList } from '../data/udhaar.ts';
import { creditListHtml } from './creditListFile.ts';

const t = ((key: string, options?: { date?: string }) =>
  key === 'office.udhaar.print_generated'
    ? `As of ${options?.date ?? ''}`
    : key) as unknown as TFunction;

const rows = [
  {
    customer: {
      id: 'c1',
      name: '<Ali & Sons>',
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

describe('credit list print file', () => {
  it('renders the customer credit table and escapes names', () => {
    const html = creditListHtml({
      shopName: 'Supreme Electronics',
      rows,
      totalOwed: 125000,
      owingCount: 1,
      tz: 'Asia/Karachi',
      lang: 'en',
      t,
      now: Date.parse('2026-11-13T10:00:00Z'),
    });
    expect(html).toContain('Supreme Electronics');
    expect(html).toContain('office.udhaar.print_title');
    expect(html).toContain('office.udhaar.total_owed');
    expect(html).toContain('&lt;Ali &amp; Sons&gt;');
    expect(html).toContain('03001234567');
    expect(html).toContain('Rs 1,250');
    expect(html).toContain('office.udhaar.no_limit');
    expect(html).toContain('office.udhaar.promise');
  });
});
