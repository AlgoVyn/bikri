import { describe, expect, it } from 'vitest';
import { csvCell, qtyCsv, rupeesCsv2 } from './csv.ts';

describe('CSV cells', () => {
  it('quotes separators and neutralises formulas but keeps real numbers numeric', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('=SUM(A1)')).toBe("'=SUM(A1)");
    expect(csvCell(-1250)).toBe('-1250');
    expect(csvCell('1234.50')).toBe('1234.50');
  });

  it('keeps phone numbers and long barcodes as text for spreadsheets', () => {
    expect(csvCell('03001234567')).toBe("'03001234567");
    expect(csvCell('8961234567890')).toBe("'8961234567890");
    expect(csvCell('PHN-0001')).toBe('PHN-0001');
  });

  it('formats money and quantities without identifiers', () => {
    expect(rupeesCsv2(123456)).toBe('1234.56');
    expect(qtyCsv(2500)).toBe('2.5');
  });
});
