import { describe, expect, it } from 'vitest';
import { fitPageCss, renderReceiptHtml } from './html.ts';
import { buildSaleReceipt, resolvePaper, saleBasicInput } from './index.ts';

describe('renderReceiptHtml (06 §5.3)', () => {
  for (const mm of [58, 80] as const) {
    it(`renders sale-basic for ${mm} mm with page CSS and the Powered by footer`, () => {
      const paper = resolvePaper({ paperMm: mm });
      const html = renderReceiptHtml(
        buildSaleReceipt(saleBasicInput(), { paperMm: mm, qr: true }),
        {
          widthMm: mm,
          charsPerLine: paper.charsPerLine,
          itemLayout: paper.itemLayout,
          logoUrl: 'data:image/png;base64,AAAA',
        },
      );
      expect(html).toContain(`@page { size: ${mm}mm 297mm; margin: 0 }`);
      expect(html).toContain('INV-A-1042');
      expect(html).toContain('<img class="logo"');
      expect(html).toContain(
        '<div class="qr">01SALEBASIC000000000000000</div>',
      );
      const lines = [
        ...html.matchAll(/<div class="l[^"]*"[^>]*>([^<]*)<\/div>/g),
      ].map((m) => m[1]);
      expect(lines.at(-1)).toBe('Powered by AlgoVyn');
      expect(html).toContain('class="l center fb"');
    });
  }

  it('escapes HTML, prints Urdu as RTL text and drops cut/drawer', () => {
    const html = renderReceiptHtml(
      [
        { t: 'logo' },
        { t: 'text', text: '<b>Ali & Sons</b>' },
        {
          t: 'text',
          text: 'شکریہ',
          align: 'right',
          bold: true,
          size: 'double-height',
        },
        { t: 'text', text: 'Double', size: 'double' },
        {
          t: 'image',
          source: {
            width: 1,
            height: 1,
            data: new Uint8Array(1),
            format: 'gray',
          },
        },
        { t: 'feed', lines: 2 },
        { t: 'cut' },
        { t: 'drawer' },
      ],
      {
        widthMm: 80,
        charsPerLine: 48,
        itemLayout: 'columns',
        title: 'Bill "1"',
      },
    );
    expect(html).toContain('&lt;b&gt;Ali &amp; Sons&lt;/b&gt;');
    expect(html).toContain(
      '<div class="l right b dh urdu" dir="rtl" lang="ur">شکریہ</div>',
    );
    expect(html).toContain('class="l dw"');
    expect(html).toContain('<title>Bill &quot;1&quot;</title>');
    expect(html).not.toContain('<img');
    expect(html.match(/class="feed"/g)).toHaveLength(2);
  });

  it('sizes the page to the content height', () => {
    expect(fitPageCss(80, 960)).toBe('@page { size: 80mm 256mm; margin: 0 }');
    expect(fitPageCss(58, 10)).toBe('@page { size: 58mm 20mm; margin: 0 }');
  });
});
