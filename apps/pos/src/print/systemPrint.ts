/**
 * System printing fallback (06 §5.3): the receipt HTML goes into a hidden iframe and its
 * window prints it, so the till page itself is never printed. Works with any printer that has
 * an OS driver; cannot kick the drawer.
 */
import { fitPageCss } from '@bikri/printer';

export type SystemPrintResult =
  | { ok: true }
  | { ok: false; code: 'NO_PRINT' | 'TIMEOUT' };

const LOAD_TIMEOUT_MS = 8000;

async function printFrame(
  html: string,
  pageWidthMm: 58 | 80 | 210,
  doc: Document,
  fixedPageCss?: string,
): Promise<SystemPrintResult> {
  const frame = doc.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  frame.setAttribute('data-testid', 'system-print-frame');
  frame.tabIndex = -1;
  Object.assign(frame.style, {
    position: 'fixed',
    right: '0',
    bottom: '0',
    width: '0',
    height: '0',
    border: '0',
    visibility: 'hidden',
  });
  const loaded = new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), LOAD_TIMEOUT_MS);
    frame.addEventListener(
      'load',
      () => {
        clearTimeout(timer);
        resolve(true);
      },
      { once: true },
    );
  });
  frame.srcdoc = html;
  doc.body.append(frame);
  try {
    if (!(await loaded)) return { ok: false, code: 'TIMEOUT' };
    const win = frame.contentWindow;
    if (win === null || typeof win.print !== 'function') {
      return { ok: false, code: 'NO_PRINT' };
    }
    // @font-face rules do not cross into a srcdoc iframe; copy them before waiting.
    const fontRules: string[] = [];
    for (const sheet of Array.from(doc.styleSheets)) {
      try {
        for (const rule of Array.from(sheet.cssRules))
          if (rule instanceof CSSFontFaceRule) fontRules.push(rule.cssText);
      } catch {
        // Cross-origin stylesheets cannot be inspected; the OS fallback still applies.
      }
    }
    if (fontRules.length > 0) {
      const fontStyle = win.document.createElement('style');
      fontStyle.textContent = fontRules.join('\n');
      win.document.head.append(fontStyle);
    }
    // Noto Naskh Arabic UI / JetBrains Mono must be ready before the driver rasterises.
    await win.document.fonts?.ready;
    // One page as long as the receipt (06 §5.3 / D-087), or a fixed A4 page.
    const style = win.document.createElement('style');
    style.textContent =
      fixedPageCss ??
      fitPageCss(
        pageWidthMm as 58 | 80,
        win.document.documentElement.scrollHeight,
      );
    win.document.head.append(style);
    win.focus();
    win.print(); // blocks until the dialog closes in Chromium
    return { ok: true };
  } finally {
    frame.remove();
  }
}

/** Prints a receipt on its 58/80 mm page through the OS print dialog. */
export function printHtmlViaSystem(
  html: string,
  widthMm: 58 | 80,
  doc: Document = document,
): Promise<SystemPrintResult> {
  return printFrame(html, widthMm, doc);
}

/** Prints a report on a standard A4 page through the OS print dialog. */
export function printA4HtmlViaSystem(
  html: string,
  doc: Document = document,
): Promise<SystemPrintResult> {
  return printFrame(html, 210, doc, '@page { size: A4; margin: 8mm }');
}

/** Prints a rendered report image on a standard A4 page. */
export async function printImageViaSystem(
  image: Blob,
  doc: Document = document,
): Promise<SystemPrintResult> {
  const url = URL.createObjectURL(image);
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0}img{display:block;width:100%;height:auto}</style></head><body><img src="${url}" alt=""></body></html>`;
  try {
    return await printA4HtmlViaSystem(html, doc);
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
}
