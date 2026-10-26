import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { toHexLines } from './golden.ts';
import {
  type Block,
  buildRefundReceipt,
  buildSaleReceipt,
  buildTestPrint,
  createFakeRasterRenderer,
  type EncodeOptions,
  encodeEscPos,
  type RasterSource,
  renderReceiptText,
  resolvePaper,
  saleBasicInput,
} from './index.ts';

// 06 §10: byte-exact goldens for sale-basic at 80 and 58 mm, plus an Urdu (all-raster) receipt.
// Regenerate deliberately with UPDATE_GOLDEN=1 and review the diff.

const HERE = dirname(fileURLToPath(import.meta.url));
const GOLDEN = join(HERE, '..', 'golden');
const FIXTURE = join(
  HERE,
  '..',
  '..',
  '..',
  'e2e',
  'fixtures',
  'sale-basic.json',
);
const UPDATE = process.env.UPDATE_GOLDEN === '1';

type SaleBasicFixture = {
  receipt_input: ReturnType<typeof saleBasicInput>;
  expected: { total: number; paid_total: number; change_given: number };
  receipt_text: { '80': string; '58': string };
};

function fixture(): SaleBasicFixture {
  return JSON.parse(readFileSync(FIXTURE, 'utf8')) as SaleBasicFixture;
}

function golden(name: string, actual: string): void {
  const path = join(GOLDEN, name);
  if (UPDATE || !existsSync(path)) {
    if (!UPDATE)
      throw new Error(`missing golden ${name}; run with UPDATE_GOLDEN=1`);
    writeFileSync(path, actual);
  }
  expect(actual, name).toBe(readFileSync(path, 'utf8'));
}

/** A deterministic 120×40 greyscale "logo": diagonal gradient with a dark border. */
function testLogo(): RasterSource {
  const width = 120;
  const height = 40;
  const data = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const border = x < 2 || y < 2 || x >= width - 2 || y >= height - 2;
      data[y * width + x] = border
        ? 0
        : Math.round(((x + y) / (width + height)) * 255);
    }
  }
  return { width, height, data, format: 'gray' };
}

function encodeSale(
  mm: 58 | 80,
  extra: Partial<EncodeOptions> = {},
): Uint8Array {
  const paper = resolvePaper({ paperMm: mm });
  const blocks = buildSaleReceipt(saleBasicInput(), { paperMm: mm });
  return encodeEscPos(blocks, {
    charsPerLine: paper.charsPerLine,
    dots: paper.dots,
    itemLayout: paper.itemLayout,
    logo: testLogo(),
    renderer: createFakeRasterRenderer(),
    ...extra,
  });
}

function hex(bytes: Uint8Array): string {
  return toHexLines(bytes).replace(/\n/g, ' ').trim();
}

function indexOf(haystack: Uint8Array, needle: number[]): number {
  outer: for (let i = 0; i + needle.length <= haystack.length; i += 1) {
    for (let j = 0; j < needle.length; j += 1) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

describe('sale-basic fixture (e2e/fixtures/sale-basic.json)', () => {
  it('matches the template input and the T2 totals (07 §3.3)', () => {
    const f = fixture();
    expect(saleBasicInput()).toEqual(f.receipt_input);
    expect(f.expected).toEqual({
      total: 4_300_000,
      paid_total: 4_300_000,
      change_given: 700_000,
    });
  });

  for (const mm of [80, 58] as const) {
    it(`renders the ${mm} mm text exactly as the fixture snapshot`, () => {
      const paper = resolvePaper({ paperMm: mm });
      const text = renderReceiptText(
        buildSaleReceipt(saleBasicInput(), { paperMm: mm }),
        paper,
      );
      expect(text).toBe(fixture().receipt_text[String(mm) as '80' | '58']);
      for (const line of text.split('\n')) {
        expect(line.length).toBeLessThanOrEqual(paper.charsPerLine);
      }
    });
  }
});

describe('ESC/POS goldens', () => {
  it('sale-basic 80 mm', () => {
    golden('sale-basic-80.hex', toHexLines(encodeSale(80)));
  });

  it('sale-basic 58 mm', () => {
    golden('sale-basic-58.hex', toHexLines(encodeSale(58)));
  });

  it('sale-basic 80 mm in Urdu mode: every text line is a raster (06 §6)', () => {
    const bytes = encodeSale(80, { language: 'ur' });
    golden('sale-basic-ur-80.hex', toHexLines(bytes));
    // No printable ASCII text runs: only commands and GS v 0 bands.
    expect(
      indexOf(
        bytes,
        [...'INV-A-1042'].map((c) => c.charCodeAt(0)),
      ),
    ).toBe(-1);
    expect(indexOf(bytes, [0x1d, 0x76, 0x30, 0x00, 72, 0])).toBeGreaterThan(0);
  });

  it('test print 80 mm', () => {
    const blocks = buildTestPrint({ charsPerLine: 48 });
    const bytes = encodeEscPos(blocks, {
      charsPerLine: 48,
      dots: 576,
      renderer: createFakeRasterRenderer(),
    });
    golden('test-print-80.hex', toHexLines(bytes));
  });
});

describe('ESC/POS commands (06 §3)', () => {
  const sale80 = encodeSale(80);

  it('starts with initialise and PC437', () => {
    expect(hex(sale80.subarray(0, 5))).toBe('1b 40 1b 74 00');
  });

  it('prints "Powered by AlgoVyn" in Font B as the last text, then returns to Font A (D-085)', () => {
    for (const bytes of [
      sale80,
      encodeSale(58),
      encodeSale(80, { language: 'ur' }),
    ]) {
      const footer = [
        0x1b,
        0x4d,
        0x01,
        ...[...'Powered by AlgoVyn'].map((c) => c.charCodeAt(0)),
        0x0a,
      ];
      const at = indexOf(bytes, footer);
      expect(at).toBeGreaterThan(0);
      expect(
        hex(bytes.subarray(at + footer.length, at + footer.length + 6)),
      ).toBe('1b 61 00 1b 4d 00');
    }
  });

  it('ends with feed 3, partial cut and drawer pin 2', () => {
    expect(hex(sale80.subarray(sale80.length - 12))).toBe(
      '1b 64 03 1d 56 42 00 1b 70 00 19 fa',
    );
  });

  it('prints the logo as GS v 0 at 72 bytes per row on 80 mm and 48 on 58 mm', () => {
    expect(indexOf(sale80, [0x1d, 0x76, 0x30, 0x00, 72, 0])).toBeGreaterThan(0);
    expect(
      indexOf(encodeSale(58), [0x1d, 0x76, 0x30, 0x00, 48, 0]),
    ).toBeGreaterThan(0);
  });

  it('honours drawer pin 5, full cut and no cut', () => {
    const pin5 = encodeSale(80, { drawerPin: 5 });
    expect(hex(pin5.subarray(pin5.length - 5))).toBe('1b 70 01 19 fa');
    expect(
      indexOf(encodeSale(80, { cut: 'full' }), [0x1d, 0x56, 0x41, 0x00]),
    ).toBeGreaterThan(0);
    const none = encodeSale(80, { cut: 'none' });
    expect(indexOf(none, [0x1d, 0x56])).toBe(-1);
  });

  it('omits the drawer when the sale has no cash', () => {
    const input = saleBasicInput();
    input.payments = [
      { method: 'card', amount: input.sale.total, reference: '1234' },
    ];
    input.sale.cashTendered = 0;
    input.sale.changeGiven = 0;
    const blocks = buildSaleReceipt(input, { paperMm: 80 });
    expect(blocks.some((b) => b.t === 'drawer')).toBe(false);
  });

  it('encodes QR model 2, module size, level M, store and print', () => {
    const bytes = encodeEscPos([{ t: 'qr', data: 'abc' }], {
      charsPerLine: 48,
      dots: 576,
    });
    expect(hex(bytes.subarray(5))).toBe(
      [
        '1b 61 01',
        '1d 28 6b 04 00 31 41 32 00',
        '1d 28 6b 03 00 31 43 06',
        '1d 28 6b 03 00 31 45 31',
        '1d 28 6b 06 00 31 50 30 61 62 63',
        '1d 28 6b 03 00 31 51 30',
      ].join(' '),
    );
    const small = encodeEscPos([{ t: 'qr', data: 'abc' }], {
      charsPerLine: 32,
      dots: 384,
    });
    expect(
      indexOf(small, [0x1d, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x43, 0x04]),
    ).toBeGreaterThan(0);
  });

  it('switches bold and size only when they change, double for the shop name', () => {
    const blocks: Block[] = [
      { t: 'text', text: 'A', bold: true, size: 'double', align: 'center' },
      { t: 'text', text: 'B', bold: true, size: 'double', align: 'center' },
      { t: 'text', text: 'C' },
    ];
    const bytes = encodeEscPos(blocks, { charsPerLine: 48, dots: 576 });
    expect(hex(bytes)).toBe(
      '1b 40 1b 74 00 1b 61 01 1b 45 01 1d 21 11 41 0a 42 0a 1b 61 00 1b 45 00 1d 21 00 43 0a',
    );
  });

  it('rasterises a non-ASCII line in place in English mode and needs a renderer for it', () => {
    const blocks: Block[] = [{ t: 'text', text: 'Chai چائے' }];
    expect(() => encodeEscPos(blocks, { charsPerLine: 48, dots: 576 })).toThrow(
      /RasterRenderer/,
    );
    const bytes = encodeEscPos(blocks, {
      charsPerLine: 48,
      dots: 576,
      renderer: createFakeRasterRenderer(),
    });
    expect(indexOf(bytes, [0x1d, 0x76, 0x30, 0x00, 72, 0, 8, 0])).toBe(5);
  });

  it('builds a refund receipt without money-back rows when nothing is paid back', () => {
    const shop = saleBasicInput().shop;
    const blocks = buildRefundReceipt(
      {
        shop,
        staffName: 'Adnan',
        customerName: 'Bilal Hussain',
        originalInvoiceNo: 'INV-A-1042',
        originalCreatedAt: Date.parse('2026-10-27T09:05:00.000Z'),
        refundCreatedAt: Date.parse('2026-10-28T09:05:00.000Z'),
        lines: [{ name: 'Earbuds', qtyMilli: 1000, amount: 350_000 }],
        exactAmount: 350_000,
        rounding: 0,
        amount: 0,
        method: null,
        udhaarPart: 350_000,
        khataBalancePaisa: 0,
        reason: 'Faulty',
      },
      { paperMm: 80 },
    );
    const text = renderReceiptText(blocks, resolvePaper({ paperMm: 80 }));
    expect(text).toContain('REFUND RECEIPT');
    expect(text).toContain('Taken off khata');
    expect(text).not.toContain('Paid back');
    expect(blocks.some((b) => b.t === 'drawer')).toBe(false);
  });
});
