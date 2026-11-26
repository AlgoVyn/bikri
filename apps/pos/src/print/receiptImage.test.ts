import {
  type Block,
  buildSaleReceipt,
  saleBasicInput,
  urduReceiptLabels,
} from '@bikri/printer';
import { describe, expect, it } from 'vitest';
import { fakeCanvasDocument } from './fakeCanvas.ts';
import {
  jpegToPdf,
  receiptRows,
  renderReceiptCanvas,
  toImageData,
} from './receiptImage.ts';

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

  it('keeps centred Urdu centred and blends transparent logo pixels over white', () => {
    const centred = receiptRows(
      [{ t: 'text', text: 'رسید', align: 'center' }],
      { dots: 576, charsPerLine: 48, itemLayout: 'columns', logo: null },
    );
    expect(centred[0]).toMatchObject({ kind: 'text', align: 'center' });
    const left = receiptRows([{ t: 'text', text: 'رسید', align: 'left' }], {
      dots: 576,
      charsPerLine: 48,
      itemLayout: 'columns',
      logo: null,
    });
    expect(left[0]).toMatchObject({ kind: 'text', align: 'right' });

    const ctx = {
      createImageData: (width: number, height: number) => ({
        width,
        height,
        data: new Uint8ClampedArray(width * height * 4),
      }),
    } as unknown as CanvasRenderingContext2D;
    const out = toImageData(ctx, {
      width: 2,
      height: 1,
      format: 'rgba',
      data: new Uint8Array([0, 0, 0, 0, 255, 0, 0, 128]),
    });
    expect([...out.data]).toEqual([255, 255, 255, 255, 255, 127, 127, 255]);
  });

  it('draws a mixed Urdu/English item in the same LTR columns as the preview', async () => {
    const { doc, calls } = fakeCanvasDocument();
    const blocks: Block[] = [
      { t: 'item', name: 'کیبل 1m', qty: '2', amount: 'Rs 900' },
    ];
    await renderReceiptCanvas(
      blocks,
      {
        dots: 576,
        charsPerLine: 48,
        itemLayout: 'columns',
        logo: null,
        padding: 0,
      },
      doc,
    );
    expect(
      calls.map((call) => [
        call.text,
        call.x,
        call.align,
        call.direction,
        call.maxWidth,
      ]),
    ).toEqual([
      ['کیبل 1m', 0, 'left', 'rtl', 336],
      ['2', 396, 'right', 'ltr', 60],
      ['Rs 900', 576, 'right', 'ltr', 180],
    ]);
  });

  it('draws the Urdu 80 mm header in name/qty/amount columns', async () => {
    const input = saleBasicInput();
    input.labels = urduReceiptLabels;
    const { doc, calls } = fakeCanvasDocument();
    await renderReceiptCanvas(
      buildSaleReceipt(input),
      {
        dots: 576,
        charsPerLine: 48,
        itemLayout: 'columns',
        logo: null,
        padding: 0,
      },
      doc,
    );
    const header = calls
      .filter((call) => ['چیز', 'تعداد', 'رقم'].includes(call.text))
      .map((call) => [
        call.text,
        call.x,
        call.align,
        call.direction,
        call.maxWidth,
      ]);
    expect(header).toEqual([
      ['چیز', 0, 'left', 'rtl', 336],
      ['تعداد', 396, 'right', 'rtl', 60],
      ['رقم', 576, 'right', 'rtl', 180],
    ]);
  });

  it('draws a QR as a scannable row, not as its payload text', () => {
    const rows = receiptRows(
      [{ t: 'qr', data: '01J0000000000000000000000A' }],
      { dots: 576, charsPerLine: 48, itemLayout: 'columns', logo: null },
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: 'qr',
      data: '01J0000000000000000000000A',
    });
    expect(rows[0]?.height).toBeGreaterThan(100);
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
