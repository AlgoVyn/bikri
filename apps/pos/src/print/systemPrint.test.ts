import {
  buildSaleReceipt,
  renderReceiptHtml,
  resolvePaper,
} from '@bikri/printer';
import { saleBasicInput } from '@bikri/printer/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { printHtmlViaSystem } from './systemPrint.ts';

function receiptHtml(): string {
  const paper = resolvePaper({ paperMm: 80 });
  return renderReceiptHtml(buildSaleReceipt(saleBasicInput()), {
    widthMm: 80,
    charsPerLine: paper.charsPerLine,
    itemLayout: paper.itemLayout,
  });
}

describe('printHtmlViaSystem', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('lets a statement shrink its logo width', () => {
    const html = renderReceiptHtml([{ t: 'logo' }], {
      widthMm: 80,
      charsPerLine: 48,
      itemLayout: 'columns',
      logoUrl: 'data:image/png;base64,AA==',
      logoWidthPct: 0.3,
    });
    expect(html).toContain('max-width:30%');
  });

  it('prints the receipt from a hidden iframe and removes it afterwards', async () => {
    const printed: string[] = [];
    const append = document.body.append.bind(document.body);
    vi.spyOn(document.body, 'append').mockImplementation((...nodes) => {
      append(...nodes);
      const frame = nodes[0] as HTMLIFrameElement;
      const win = frame.contentWindow as Window;
      win.print = () => {
        printed.push(frame.srcdoc);
        // Chromium fires afterprint before print() resolves; keep the test frame
        // cleanup path identical to a real dialog.
        win.dispatchEvent(new Event('afterprint'));
      };
      frame.dispatchEvent(new Event('load'));
    });
    const result = await printHtmlViaSystem(receiptHtml(), 80);
    expect(result).toEqual({ ok: true });
    expect(printed).toHaveLength(1);
    expect(printed[0]).toContain('Powered by AlgoVyn');
    expect(
      document.querySelector('[data-testid="system-print-frame"]'),
    ).toBeNull();
  });

  it('keeps the frame until afterprint so an async dialog is not cancelled', async () => {
    const captured: { win: Window | null } = { win: null };
    const append = document.body.append.bind(document.body);
    vi.spyOn(document.body, 'append').mockImplementation((...nodes) => {
      append(...nodes);
      const frame = nodes[0] as HTMLIFrameElement;
      captured.win = frame.contentWindow as Window;
      captured.win.print = () => undefined;
      frame.dispatchEvent(new Event('load'));
    });
    expect(await printHtmlViaSystem(receiptHtml(), 80)).toEqual({ ok: true });
    expect(
      document.querySelector('[data-testid="system-print-frame"]'),
    ).not.toBeNull();
    captured.win?.dispatchEvent(new Event('afterprint'));
    expect(
      document.querySelector('[data-testid="system-print-frame"]'),
    ).toBeNull();
  });

  it('reports NO_PRINT when the frame has no print function', async () => {
    const append = document.body.append.bind(document.body);
    vi.spyOn(document.body, 'append').mockImplementation((...nodes) => {
      append(...nodes);
      const frame = nodes[0] as HTMLIFrameElement;
      Object.defineProperty(frame.contentWindow as Window, 'print', {
        value: undefined,
      });
      frame.dispatchEvent(new Event('load'));
    });
    expect(await printHtmlViaSystem('<p>x</p>', 58)).toEqual({
      ok: false,
      code: 'NO_PRINT',
    });
  });

  it('times out when the frame never loads', async () => {
    vi.useFakeTimers();
    vi.spyOn(document.body, 'append').mockImplementation(() => undefined);
    const pending = printHtmlViaSystem('<p>x</p>', 58);
    await vi.advanceTimersByTimeAsync(8000);
    expect(await pending).toEqual({ ok: false, code: 'TIMEOUT' });
    vi.useRealTimers();
  });

  it('does not wait forever for iframe fonts that never become ready', async () => {
    vi.useFakeTimers();
    const append = document.body.append.bind(document.body);
    vi.spyOn(document.body, 'append').mockImplementation((...nodes) => {
      append(...nodes);
      const frame = nodes[0] as HTMLIFrameElement;
      const win = frame.contentWindow as Window;
      Object.defineProperty(win.document, 'fonts', {
        configurable: true,
        value: { ready: new Promise(() => undefined) },
      });
      win.print = () => win.dispatchEvent(new Event('afterprint'));
      frame.dispatchEvent(new Event('load'));
    });
    const pending = printHtmlViaSystem('<p>x</p>', 58);
    await vi.advanceTimersByTimeAsync(2000);
    expect(await pending).toEqual({ ok: true });
    expect(
      document.querySelector('[data-testid="system-print-frame"]'),
    ).toBeNull();
    vi.useRealTimers();
  });
});
