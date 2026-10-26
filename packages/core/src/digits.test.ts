import { describe, expect, it } from 'vitest';
import { normaliseDigits, normaliseNumericText } from './digits.ts';

describe('normaliseDigits', () => {
  it('maps Urdu digits ۰-۹ to 0-9', () => {
    expect(normaliseDigits('۰۱۲۳۴۵۶۷۸۹')).toBe('0123456789');
  });

  it('maps Arabic-Indic digits ٠-٩ to 0-9', () => {
    expect(normaliseDigits('٠١٢٣٤٥٦٧٨٩')).toBe('0123456789');
  });

  it('leaves other characters in place', () => {
    expect(normaliseDigits('Rs ۴۳.۵')).toBe('Rs 43.5');
    expect(normaliseDigits('')).toBe('');
  });

  it('treats the Arabic decimal and thousands separators as numeric punctuation', () => {
    expect(normaliseNumericText('۴۳٬۰۰۰٫۵')).toBe('43000.5');
  });
});
