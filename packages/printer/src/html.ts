import {
  hasNonAscii,
  type ItemLayout,
  type LaidCell,
  type LaidText,
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
  /** Logo width as a fraction of the printable width. Default 0.6. */
  logoWidthPct?: number;
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
  ".urdu { font-family: 'Noto Naskh Arabic UI', 'Noto Naskh Arabic', serif; direction: rtl; line-height: 1.7; white-space: normal }",
  // Rows keep their columns even when a cell is Urdu: flex/grid spaces them, so
  // `.urdu`'s `white-space: normal` can never collapse the padding.
  '.pair { display: flex; justify-content: space-between; gap: 1ch; align-items: baseline }',
  '.pair > span { white-space: pre-wrap }',
  '.row { display: grid; align-items: baseline }',
  '.row > .v { white-space: nowrap; overflow: hidden; text-overflow: ellipsis }',
  '.row > .v, .pair > .v { text-align: end }',
  ".rtl { font-family: 'Noto Naskh Arabic UI', 'Noto Naskh Arabic', serif }",
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

function cellHtml(cell: LaidCell): string {
  const classes: string[] = [];
  if (cell.align === 'end') classes.push('v');
  const rtl = lineNeedsRtl(cell.text);
  if (rtl) classes.push('rtl');
  const classAttr = classes.length > 0 ? ` class="${classes.join(' ')}"` : '';
  // `dir="auto"` keeps an Urdu label inside its own cell instead of flipping the row.
  const dir = rtl ? ' dir="auto"' : '';
  return `<span${classAttr}${dir}>${escapeHtml(cell.text)}</span>`;
}

/**
 * A pair (label/value) or item (name/qty/amount) row as real columns. The ESC/POS
 * side keeps the space-padded string in `command.text`; only the HTML fallback
 * needs structure so Urdu cells do not collapse the spacing.
 */
function cellsHtml(cells: LaidCell[], command: LaidText): string {
  const classes = [cells.length > 2 ? 'row' : 'pair'];
  if (command.bold) classes.push('b');
  if (command.size === 'small') classes.push('sm');
  if (command.size === 'double') classes.push('dw');
  if (command.size === 'double-height') classes.push('dh');
  const style =
    cells.length > 2
      ? ' style="grid-template-columns:minmax(0,1fr) 5ch 15ch"'
      : '';
  return `<div class="${classes.join(' ')}"${style}>${cells
    .map(cellHtml)
    .join('')}</div>`;
}

/**
 * The system fallback writes the receipt into a same-origin `srcdoc` iframe, so a
 * `javascript:`/SVG data URL in the logo would execute. Only raster data URLs and
 * plain same-origin paths are allowed; anything else is omitted.
 */
function safeLogoUrl(url: string): string | null {
  const value = url.trim();
  if (/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/u.test(value))
    return value;
  if (
    value.length > 0 &&
    !value.startsWith('//') &&
    /^[A-Za-z0-9._~%/-]+(?:[?#][A-Za-z0-9._~%=&/-]*)?$/u.test(value)
  )
    return value;
  return null;
}

/**
 * `@page` rule that sizes the page to the rendered receipt: `80mm auto` is not valid CSS
 * (Chromium ignores it), so the printing code measures the body and appends this (D-087).
 */
export function fitPageCss(widthMm: 58 | 80, contentHeightPx: number): string {
  const heightPx = Number.isFinite(contentHeightPx) ? contentHeightPx : 0;
  const heightMm = Math.max(20, Math.ceil((heightPx * 25.4) / 96) + 2);
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
      case 'logo': {
        const logoUrl = options.logoUrl ? safeLogoUrl(options.logoUrl) : null;
        if (logoUrl) {
          const widthPct = Math.round(
            Math.min(1, Math.max(0.1, options.logoWidthPct ?? 0.6)) * 100,
          );
          body.push(
            `<div class="logo-wrap"><img class="logo" style="max-width:${widthPct}%" alt="" src="${escapeHtml(logoUrl)}"></div>`,
          );
        }
        break;
      }
      case 'text': {
        // Style the branding line only where pushPoweredBy put it (Font B,
        // centred); a shop footer that happens to repeat the words stays a
        // normal line.
        if (
          command.text === POWERED_BY &&
          command.size === 'small' &&
          command.align === 'center'
        ) {
          body.push(`<p class="powered-by">${POWERED_BY}</p>`);
          break;
        }
        if (command.cells && command.cells.length > 0) {
          body.push(cellsHtml(command.cells, command));
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
          if (lineNeedsRtl(command.text)) {
            classes.push('urdu');
            attrs = ' dir="rtl" lang="ur"';
          }
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
      // The HTML fallback v1 has no arbitrary-image renderer (the shop logo is the
      // only image); cut and drawer have no HTML equivalent.
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
