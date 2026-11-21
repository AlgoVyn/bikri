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
      // 06 §4.4: the last element of the body is the small Powered by line.
      expect(html).toMatch(
        /<p class="powered-by">Powered by AlgoVyn<\/p>\n(<div class="feed"><\/div>\n)*<\/body>/,
      );
      expect(html).toContain(
        '.powered-by { text-align: center; font-size: 8px; margin: 2mm 0 0 }',
      );
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
    expect(fitPageCss(80, Number.NaN)).toBe(
      '@page { size: 80mm 20mm; margin: 0 }',
    );
    expect(fitPageCss(80, Number.POSITIVE_INFINITY)).toBe(
      '@page { size: 80mm 20mm; margin: 0 }',
    );
  });

  it('styles the branding line only in the pushed Font B centre style', () => {
    // A footer that happens to repeat the words is an ordinary line.
    const footer = renderReceiptHtml(
      [{ t: 'text', text: 'Powered by AlgoVyn' }],
      { widthMm: 80, charsPerLine: 48, itemLayout: 'columns' },
    );
    expect(footer).not.toContain('<p class="powered-by">');
    expect(footer).toContain('<div class="l">Powered by AlgoVyn</div>');
    const powered = renderReceiptHtml(
      [
        {
          t: 'text',
          text: 'Powered by AlgoVyn',
          align: 'center',
          size: 'small',
        },
      ],
      { widthMm: 80, charsPerLine: 48, itemLayout: 'columns' },
    );
    expect(powered).toContain('<p class="powered-by">Powered by AlgoVyn</p>');
  });

  it('drops unsafe logo URLs from the print iframe', () => {
    const render = (logoUrl: string) =>
      renderReceiptHtml([{ t: 'logo' }], {
        widthMm: 80,
        charsPerLine: 48,
        itemLayout: 'columns',
        logoUrl,
      });
    for (const unsafe of [
      'javascript:alert(1)',
      'data:image/svg+xml,<svg onload=alert(1)>',
      '//evil.example/logo.png',
      'https://evil.example/logo.png',
    ])
      expect(render(unsafe)).not.toContain('<img');
    expect(render('brand/logo.png')).toContain(
      '<img class="logo" style="max-width:60%" alt="" src="brand/logo.png">',
    );
    expect(render('/bikri/brand/logo.png')).toContain(
      'src="/bikri/brand/logo.png"',
    );
  });
});
