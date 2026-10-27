import { describe, expect, it } from 'vitest';
import { previewBlocks } from './ReceiptPreview.tsx';
import { parseTaxPercent } from './SetupWizard.tsx';

describe('setup step 3 helpers', () => {
  it('parses tax percent to basis points (0–25, 2 decimals)', () => {
    expect(parseTaxPercent('17')).toBe(1700);
    expect(parseTaxPercent('17.5')).toBe(1750);
    expect(parseTaxPercent('۱۷')).toBe(1700);
    expect(parseTaxPercent('')).toBe(0);
    expect(parseTaxPercent('25')).toBe(2500);
    expect(parseTaxPercent('25.01')).toBeNull();
    expect(parseTaxPercent('1.234')).toBeNull();
    expect(parseTaxPercent('abc')).toBeNull();
  });

  it('previews a tax line only when tax is on, and always the Powered by line', () => {
    const base = {
      name: 'Shop',
      address: 'Hall Road',
      phone: '+923001234567',
      header: '',
      footer: 'Thanks',
      tax_rate_bp: 0,
      inclusive: false,
    };
    const text = (s: typeof base) => JSON.stringify(previewBlocks(s));
    expect(text(base)).not.toContain('Sales tax');
    expect(text({ ...base, tax_rate_bp: 1700 })).toContain('Sales tax 17%');
    expect(text({ ...base, tax_rate_bp: 1700, inclusive: true })).toContain(
      'Includes Sales tax 17%',
    );
    expect(previewBlocks(base).at(-1)).toEqual({
      t: 'text',
      text: 'Powered by AlgoVyn',
      align: 'center',
      size: 'small',
    });
  });
});
