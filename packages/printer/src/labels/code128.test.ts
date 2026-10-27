import { describe, expect, it } from 'vitest';
import fixtures from '../../../../docs/fixtures/barcode-code128.json';
import { BarcodeError, encodeCode128 } from './code128.ts';

describe('Code 128 (screens/20 AC 1)', () => {
  it('matches every fixture symbol, check and module count', () => {
    for (const vector of fixtures.vectors) {
      const result = encodeCode128(vector.value);
      expect(result.symbols, vector.value).toEqual(vector.symbols);
      expect(result.check, vector.value).toBe(vector.check);
      expect(result.modules, vector.value).toBe(vector.modules_incl_quiet);
    }
  });

  it('rejects empty and non-ASCII values', () => {
    expect(() => encodeCode128('')).toThrow(BarcodeError);
    expect(() => encodeCode128('اردو')).toThrow(BarcodeError);
  });
});
