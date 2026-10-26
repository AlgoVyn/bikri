import {
  buildRefundReceipt,
  buildSaleReceipt,
  fitPageCss,
  renderReceiptHtml,
  resolvePaper,
  saleBasicInput,
} from '@bikri/printer';
import { expect, test } from '@playwright/test';

// T-019 / 06 §5.3: the window.print fallback. Real print dialogs cannot be driven headlessly, so this
// renders the receipt document in Chromium with print media, checks the layout fits the paper,
// prints it to PDF with the receipt's own @page size, and checks the hidden-iframe print call.
// Whether a given thermal driver honours `80mm auto` is a hardware check (10 §6 H3).

const MM_TO_PT = 72 / 25.4;

function html(mm: 58 | 80, kind: 'sale' | 'refund' = 'sale'): string {
  const paper = resolvePaper({ paperMm: mm });
  const input = saleBasicInput();
  const blocks =
    kind === 'sale'
      ? buildSaleReceipt(input, { paperMm: mm })
      : buildRefundReceipt(
          {
            shop: input.shop,
            staffName: 'Adnan',
            customerName: null,
            originalInvoiceNo: 'INV-A-1042',
            originalCreatedAt: input.sale.createdAt,
            refundCreatedAt: input.sale.createdAt + 3_600_000,
            lines: [
              { name: 'ایئربڈز Earbuds', qtyMilli: 1000, amount: 350_000 },
            ],
            exactAmount: 350_000,
            rounding: 0,
            amount: 350_000,
            method: 'cash',
            udhaarPart: 0,
            khataBalancePaisa: null,
            reason: 'Faulty',
          },
          { paperMm: mm },
        );
  return renderReceiptHtml(blocks, {
    widthMm: mm,
    charsPerLine: paper.charsPerLine,
    itemLayout: paper.itemLayout,
    title: 'INV-A-1042',
  });
}

for (const mm of [80, 58] as const) {
  test(`window.print fallback lays out a ${mm} mm receipt`, async ({
    page,
  }, info) => {
    test.skip(
      info.project.name !== 'desktop',
      'paper layout does not depend on the viewport',
    );
    await page.goto('/bikri/');
    await page.emulateMedia({ media: 'print' });
    for (const kind of ['sale', 'refund'] as const) {
      await page.setContent(html(mm, kind));
      const metrics = await page.evaluate(() => {
        const lines = [...document.querySelectorAll<HTMLElement>('.l')];
        return {
          bodyWidth: document.body.getBoundingClientRect().width,
          overflowing: lines
            .filter(
              (l) =>
                !l.classList.contains('urdu') &&
                l.scrollWidth > l.clientWidth + 1,
            )
            .map((l) => l.textContent),
          last: lines.at(-1)?.textContent,
          urdu: lines
            .filter((l) => l.classList.contains('urdu'))
            .map((l) => l.dir),
        };
      });
      const expectedMm = mm === 80 ? 72 : 48;
      expect(metrics.bodyWidth).toBeCloseTo((expectedMm / 25.4) * 96, 0);
      expect(metrics.overflowing).toEqual([]);
      expect(metrics.last).toBe('Powered by AlgoVyn');
      if (kind === 'refund') expect(metrics.urdu).toEqual(['rtl']);
      const height = await page.evaluate(
        () => document.documentElement.scrollHeight,
      );
      await page.addStyleTag({ content: fitPageCss(mm, height) });
      const pdf = (await page.pdf({ preferCSSPageSize: true })).toString(
        'latin1',
      );
      const box = /\/MediaBox\s*\[\s*0 0 ([\d.]+) ([\d.]+)\s*\]/.exec(pdf);
      expect(box).not.toBeNull();
      expect(Number(box?.[1])).toBeCloseTo(mm * MM_TO_PT, 0);
      expect(Number(box?.[2])).toBeLessThan(297 * MM_TO_PT);
      // One page, as long as the receipt.
      expect(pdf.match(/\/Type\s*\/Page[^s]/g)).toHaveLength(1);
    }
  });
}

test('the receipt prints from a hidden iframe, not the till page', async ({
  page,
}, info) => {
  test.skip(info.project.name !== 'desktop', 'one viewport is enough');
  await page.goto('/bikri/');
  const printed = await page.evaluate(async (receipt) => {
    // Same steps as apps/pos/src/print/systemPrint.ts (unit-tested there), in a real browser.
    let topPrinted = false;
    window.print = () => {
      topPrinted = true;
    };
    const frame = document.createElement('iframe');
    frame.style.visibility = 'hidden';
    const loaded = new Promise((r) =>
      frame.addEventListener('load', r, { once: true }),
    );
    frame.srcdoc = receipt;
    document.body.append(frame);
    await loaded;
    const win = frame.contentWindow as Window;
    let text = '';
    win.print = () => {
      text = win.document.body.textContent ?? '';
    };
    await win.document.fonts.ready;
    win.print();
    frame.remove();
    return { text, topPrinted };
  }, html(80));
  expect(printed.topPrinted).toBe(false);
  expect(printed.text).toContain('INV-A-1042');
  expect(printed.text.trim().endsWith('Powered by AlgoVyn')).toBe(true);
});
