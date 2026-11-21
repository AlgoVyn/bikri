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
/** Safety net for browsers that never fire afterprint (the dialog is already gone). */
const CLEANUP_TIMEOUT_MS = 60_000;

/* Copying @font-face rules is a CSSOM scan of every stylesheet; the rules do not
   change while the app runs, so do it once per document. */
const fontFaceCache = new WeakMap<Document, string>();

function fontFaceCss(doc: Document): string {
  const cached = fontFaceCache.get(doc);
  if (cached !== undefined) return cached;
  const rules: string[] = [];
  for (const sheet of Array.from(doc.styleSheets)) {
    try {
      for (const rule of Array.from(sheet.cssRules))
        if (rule instanceof CSSFontFaceRule) rules.push(rule.cssText);
    } catch {
      // Cross-origin stylesheets cannot be inspected; the OS fallback still applies.
    }
  }
  const css = rules.join('\n');
  fontFaceCache.set(doc, css);
  return css;
}

export async function printHtmlViaSystem(
  html: string,
  widthMm: 58 | 80,
  doc: Document = document,
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
  let printed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    if (!(await loaded)) return { ok: false, code: 'TIMEOUT' };
    const win = frame.contentWindow;
    if (win === null || typeof win.print !== 'function') {
      return { ok: false, code: 'NO_PRINT' };
    }
    // @font-face rules do not cross into a srcdoc iframe; copy them before waiting.
    const fontRules = fontFaceCss(doc);
    if (fontRules !== '') {
      const fontStyle = win.document.createElement('style');
      fontStyle.textContent = fontRules;
      win.document.head.append(fontStyle);
    }
    // Noto Naskh Arabic UI / JetBrains Mono must be ready before the driver rasterises.
    await win.document.fonts?.ready;
    // One page as long as the receipt (06 §5.3 / D-087).
    const style = win.document.createElement('style');
    style.textContent = fitPageCss(
      widthMm,
      win.document.documentElement.scrollHeight,
    );
    win.document.head.append(style);
    // Safari/Firefox/mobile may show the dialog asynchronously; removing the
    // frame immediately cancels it. Keep it until afterprint (or a safe fallback).
    const cleanup = () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      frame.remove();
    };
    win.addEventListener('afterprint', cleanup, { once: true });
    timer = setTimeout(cleanup, CLEANUP_TIMEOUT_MS);
    win.focus();
    win.print(); // blocks until the dialog closes in Chromium
    printed = true;
    return { ok: true };
  } finally {
    if (!printed) {
      if (timer !== null) clearTimeout(timer);
      frame.remove();
    }
  }
}
