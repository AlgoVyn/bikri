import { describe, expect, it } from 'vitest';
import { formatMoney, groupLakh, parseMoneyToPaisa } from './moneyFormat.ts';

describe('parseMoneyToPaisa', () => {
  it('parses whole rupees and at most 2 decimals', () => {
    expect(parseMoneyToPaisa('43000')).toBe(4_300_000);
    expect(parseMoneyToPaisa('43,000')).toBe(4_300_000);
    expect(parseMoneyToPaisa('Rs 43,000')).toBe(4_300_000);
    expect(parseMoneyToPaisa('3,459.77')).toBe(345_977);
    expect(parseMoneyToPaisa('43.7')).toBe(4_370);
    expect(parseMoneyToPaisa('.5')).toBe(50);
    expect(parseMoneyToPaisa('0')).toBe(0);
    expect(parseMoneyToPaisa('43.')).toBe(4_300);
  });

  it('normalises Urdu and Arabic-Indic digits', () => {
    expect(parseMoneyToPaisa('۴۳')).toBe(4_300);
    expect(parseMoneyToPaisa('٤٣٫٥٠')).toBe(4_350);
    expect(parseMoneyToPaisa('۴۳٬۰۰۰')).toBe(4_300_000);
  });

  it('rejects a third decimal and junk', () => {
    expect(parseMoneyToPaisa('43.777')).toBeNull();
    expect(parseMoneyToPaisa('12.3.4')).toBeNull();
    expect(parseMoneyToPaisa('abc')).toBeNull();
    expect(parseMoneyToPaisa('')).toBeNull();
    expect(parseMoneyToPaisa('-')).toBeNull();
  });

  it('allows a leading minus only when asked', () => {
    expect(parseMoneyToPaisa('-500')).toBeNull();
    expect(parseMoneyToPaisa('−500')).toBeNull();
    expect(parseMoneyToPaisa('-500', { allowNegative: true })).toBe(-50_000);
    expect(parseMoneyToPaisa('−Rs 500', { allowNegative: true })).toBe(-50_000);
  });
});

describe('formatMoney', () => {
  it('formats the documented examples', () => {
    expect(formatMoney(4_300_000)).toBe('Rs 43,000');
    expect(formatMoney(345_977)).toBe('Rs 3,459.77');
    expect(formatMoney(-50_000)).toBe('\u2212Rs 500');
    expect(formatMoney(12_450_000, 'intl')).toBe('Rs 124,500');
    expect(formatMoney(12_450_000, 'lakh')).toBe('Rs 1,24,500');
  });

  it('keeps a leading zero on a single paisa digit', () => {
    expect(formatMoney(1)).toBe('Rs 0.01');
    expect(formatMoney(10)).toBe('Rs 0.10');
    expect(formatMoney(0)).toBe('Rs 0');
    expect(formatMoney(-1)).toBe('\u2212Rs 0.01');
  });

  it('groups lakh style after the first three digits', () => {
    expect(groupLakh(1000)).toBe('1,000');
    expect(groupLakh(100000)).toBe('1,00,000');
    expect(groupLakh(10000000)).toBe('1,00,00,000');
  });
});
