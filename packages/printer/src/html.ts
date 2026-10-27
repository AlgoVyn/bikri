import {
  hasNonAscii,
  type ItemLayout,
  layOut,
  lineNeedsRtl,
} from './layout.ts';
import { POWERED_BY } from './templates/common.ts';
import type { Block } from './types.ts';

export type HtmlOptions = {
  /** 58 or 80 mm page CSS (06 §5.3). */
  widthMm: 58 | 80;
  charsPerLine: number;
  itemLayout: ItemLayout;
  /** Data URL or same-origin URL of the shop's logo; omitted when null. */
  logoUrl?: string | null;
  /** Document title (shown in the print dialog). */
  title?: string;
};

/** Printable width and side margin per paper (06 §5.3). */
const PAGE: Record<58 | 80, { body: number; margin: number }> = {
  80: { body: 72, margin: 4 },
  58: { body: 48, margin: 5 },
};

/**
 * Monospace glyphs are 0.6 em wide, so the font size is chosen to fit exactly
 * `charsPerLine` columns in the printable width (D-087: 06's fixed 12px / 10px overflow).
 */
function pageCss(widthMm: 58 | 80, charsPerLine: number): string {
  const { body, margin } = PAGE[widthMm];
  const fontMm = (body / (charsPerLine * 0.6)).toFixed(3);
  return `@page { size: ${widthMm}mm 297mm; margin: 0 } body { width: ${body}mm; margin: 0 ${margin}mm; font: ${fontMm}mm/1.35 'JetBrains Mono', monospace }`;
}

const COMMON_CSS = [
  'html, body { background: #fff; color: #000 }',
  '.l { white-space: pre; overflow: hidden }',
  '.center { text-align: center } .right { text-align: right }',
  '.b { font-weight: 700 } .dw { font-size: 2em; line-height: 1.2 }',
  // Double height only (1D 21 01): stretch vertically, keep the column width.
  '.dh { transform: scaleY(2); transform-origin: top left; height: 2.7em }',
  '.logo-wrap { text-align: center } img.logo { max-width: 60%; }',
  ".urdu { font-family: 'Noto Nastaliq Urdu'; direction: rtl; line-height: 1.9; white-space: normal }",
  '.qr { text-align: center; font-size: 0.8em }',
  // 06 §4.4: the Powered by line; other small (Font B) text is 3/4 of the body.
  '.powered-by { text-align: center; font-size: 8px; margin: 2mm 0 0 }',
  '.sm { font-size: 0.75em }',
  '.feed { height: 1.35em }',
].join('\n');

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/**
 * `@page` rule that sizes the page to the rendered receipt: `80mm auto` is not valid CSS
 * (Chromium ignores it), so the printing code measures the body and appends this (D-087).
 */
export function fitPageCss(widthMm: 58 | 80, contentHeightPx: number): string {
  const heightMm = Math.max(20, Math.ceil((contentHeightPx * 25.4) / 96) + 2);
  return `@page { size: ${widthMm}mm ${heightMm}mm; margin: 0 }`;
}

/**
 * Receipt as a standalone HTML document for `window.print()` (06 §5.3).
 * Same block model as ESC/POS; Urdu prints as real text (the OS driver rasterises it).
 * Cut and drawer have no HTML equivalent and are dropped.
 */
export function renderReceiptHtml(
  blocks: Block[],
  options: HtmlOptions,
): string {
  const body: string[] = [];
  for (const command of layOut(blocks, {
    charsPerLine: options.charsPerLine,
    itemLayout: options.itemLayout,
  })) {
    switch (command.kind) {
      case 'logo':
        if (options.logoUrl) {
          body.push(
            `<div class="logo-wrap"><img class="logo" alt="" src="${escapeHtml(options.logoUrl)}"></div>`,
          );
        }
        break;
      case 'text': {
        if (command.text === POWERED_BY) {
          body.push(`<p class="powered-by">${POWERED_BY}</p>`);
          break;
        }
        const classes = ['l'];
        if (command.align !== 'left') classes.push(command.align);
        if (command.bold) classes.push('b');
        if (command.size === 'double') classes.push('dw');
        if (command.size === 'double-height') classes.push('dh');
        if (command.size === 'small') classes.push('sm');
        let attrs = '';
        if (hasNonAscii(command.text)) {
          classes.push('urdu');
          attrs = lineNeedsRtl(command.text) ? ' dir="rtl" lang="ur"' : '';
        }
        body.push(
          `<div class="${classes.join(' ')}"${attrs}>${escapeHtml(command.text)}</div>`,
        );
        break;
      }
      case 'qr':
        // No QR image in the browser fallback v1; print the payload so the bill can still be looked up.
        body.push(`<div class="qr">${escapeHtml(command.data)}</div>`);
        break;
      case 'feed':
        for (let i = 0; i < command.lines; i += 1)
          body.push('<div class="feed"></div>');
        break;
      case 'image':
      case 'cut':
      case 'drawer':
        break;
      default: {
        const unreachable: never = command;
        throw new Error(`unknown command ${JSON.stringify(unreachable)}`);
      }
    }
  }
  const title = escapeHtml(options.title ?? 'Receipt');
  return [
    '<!doctype html>',
    `<html lang="en"><head><meta charset="utf-8"><title>${title}</title>`,
    `<style>${pageCss(options.widthMm, options.charsPerLine)}\n${COMMON_CSS}</style></head>`,
    `<body data-width-mm="${options.widthMm}">`,
    ...body,
    '</body></html>',
  ].join('\n');
}
