import { describe, expect, it } from 'vitest';
import { fitPageCss, renderReceiptHtml } from './html.ts';
import { buildSaleReceipt, resolvePaper, urduReceiptLabels } from './index.ts';
import { saleBasicInput } from './templates/saleBasicFixture.ts';

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

  it('keeps pair column spacing when the label is Urdu', () => {
    const html = renderReceiptHtml(
      [{ t: 'pair', left: 'کل بیلنس', right: 'Rs 1,250' }],
      { widthMm: 80, charsPerLine: 48, itemLayout: 'columns' },
    );
    // A flex row, not a space-padded `.l` line that `.urdu` would collapse.
    expect(html).toContain(
      '<div class="pair"><span class="rtl" dir="rtl" lang="ur">کل بیلنس</span><span class="v">Rs 1,250</span></div>',
    );
    expect(html).not.toContain('class="l urdu"');
  });

  it('renders an item as a grid with name, qty and amount columns', () => {
    const html = renderReceiptHtml(
      [{ t: 'item', name: 'USB-C cable 1m', qty: '2', amount: 'Rs 900' }],
      { widthMm: 80, charsPerLine: 48, itemLayout: 'columns' },
    );
    expect(html).toContain(
      '<div class="row" style="grid-template-columns:minmax(0,1fr) 5ch 15ch">',
    );
    expect(html).toContain('<span>USB-C cable 1m</span>');
    expect(html).toContain('<span class="v">2</span>');
    expect(html).toContain('<span class="v">Rs 900</span>');
  });

  it('renders the 80 mm column header as the same grid, not space-padded text', () => {
    const html = renderReceiptHtml(buildSaleReceipt(saleBasicInput()), {
      widthMm: 80,
      charsPerLine: 48,
      itemLayout: 'columns',
    });
    expect(html).toContain(
      '<div class="row" style="grid-template-columns:minmax(0,1fr) 5ch 15ch"><span>ITEM</span><span class="v">QTY</span><span class="v">AMOUNT</span></div>',
    );
    expect(html).not.toMatch(/<div class="l">ITEM {10,}/);
  });

  it('keeps an Urdu column header in its own grid cells', () => {
    const input = saleBasicInput();
    input.labels = urduReceiptLabels;
    const html = renderReceiptHtml(buildSaleReceipt(input), {
      widthMm: 80,
      charsPerLine: 48,
      itemLayout: 'columns',
    });
    expect(html).toContain('<span class="rtl" dir="rtl" lang="ur">چیز</span>');
    expect(html).toContain(
      '<span class="v rtl" dir="rtl" lang="ur">تعداد</span>',
    );
    expect(html).toContain(
      '<span class="v rtl" dir="rtl" lang="ur">رقم</span>',
    );
  });

  it('keeps an Urdu item name inside its own grid cell', () => {
    const html = renderReceiptHtml(
      [{ t: 'item', name: 'کیبل 1m', qty: '2', amount: 'Rs 900' }],
      { widthMm: 80, charsPerLine: 48, itemLayout: 'columns' },
    );
    expect(html).toContain(
      '<span class="rtl" dir="rtl" lang="ur">کیبل 1m</span>',
    );
    expect(html).toContain('<span class="v">Rs 900</span>');
  });

  it('keeps a stacked 58 mm item name and its qty/amount pair row separate', () => {
    const html = renderReceiptHtml(
      [{ t: 'item', name: 'Samsung A15', qty: '1', amount: 'Rs 40,000' }],
      { widthMm: 58, charsPerLine: 32, itemLayout: 'stacked' },
    );
    expect(html).toContain('<div class="l">Samsung A15</div>');
    expect(html).toContain(
      '<div class="pair"><span>1</span><span class="v">Rs 40,000</span></div>',
    );
    expect(html).not.toContain('class="row"');
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
