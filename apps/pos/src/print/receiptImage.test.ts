import { buildSaleReceipt, saleBasicInput } from '@bikri/printer';
import { describe, expect, it } from 'vitest';
import { jpegToPdf, receiptRows } from './receiptImage.ts';

describe('receipt picture (screens/07 AC 2)', () => {
  it('uses the thermal line layout: title, REPRINT, Powered by line', () => {
    const base = saleBasicInput();
    const blocks = buildSaleReceipt({
      ...base,
      sale: { ...base.sale, reprint: true },
    });
    const rows = receiptRows(blocks, {
      dots: 576,
      charsPerLine: 48,
      itemLayout: 'columns',
      logo: { width: 8, height: 4, data: new Uint8Array(32), format: 'gray' },
    });
    const texts = rows.flatMap((r) =>
      r.kind === 'text' ? [r.text.trim()] : [],
    );
    const title = texts.indexOf('SALE RECEIPT');
    expect(texts[title + 1]).toBe('REPRINT');
    expect(texts.at(-1)).toBe('Powered by AlgoVyn');
    expect(rows[0]?.kind).toBe('raster');
    expect(rows.every((r) => r.height > 0)).toBe(true);
  });

  it('wraps a JPEG in a one-page PDF at paper width', () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9]);
    const pdf = new TextDecoder('latin1').decode(
      jpegToPdf(jpeg, 608, 1200, 80),
    );
    expect(pdf.startsWith('%PDF-1.4')).toBe(true);
    expect(pdf).toContain('/MediaBox [0 0 226.77 447.58]');
    expect(pdf).toContain('/Width 608 /Height 1200');
    expect(pdf).toContain('/Length 7');
    const xref = Number(/startxref\n(\d+)/u.exec(pdf)?.[1]);
    expect(pdf.slice(xref, xref + 4)).toBe('xref');
    const off = Number(/0 6\n0000000000 65535 f \n(\d{10})/u.exec(pdf)?.[1]);
    expect(pdf.slice(off, off + 7)).toBe('1 0 obj');
  });
});
