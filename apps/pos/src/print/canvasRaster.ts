/** Browser text rasteriser for Urdu / non-ASCII receipt lines (06 §6). */
import {
  columnWidths,
  lineNeedsRtl,
  type RasterRenderer,
  type RasterSource,
  type RenderLineOptions,
} from '@bikri/printer';

const PX: Record<RenderLineOptions['size'], number> = {
  small: 17,
  normal: 24,
  'double-height': 24,
  double: 48,
};

/** Canvas silently falls back if the font is not loaded; the thermal path must await these. */
export async function prepareRasterFonts(
  doc: Document = document,
): Promise<void> {
  const fonts = doc.fonts;
  if (!fonts) return;
  // JetBrains Mono is the receipt's ASCII face (receiptImage.ts); without it the
  // canvas falls back to the OS monospace and the glyph grid stops matching the
  // 48/32-column layout. The woff2 ships with the app (styles/fonts.css).
  await Promise.allSettled([
    fonts.load('400 24px "Noto Naskh Arabic UI"'),
    fonts.load('700 24px "Noto Naskh Arabic UI"'),
    fonts.load('400 24px Inter'),
    fonts.load('700 24px Inter'),
    fonts.load('400 24px "JetBrains Mono"'),
    fonts.load('700 24px "JetBrains Mono"'),
  ]);
}

export function createCanvasRasterRenderer(
  doc: Document = document,
): RasterRenderer {
  // One backing bitmap per line size. Resizing a canvas drops and reallocates its
  // bitmap, which used to happen for every one of the 40–60 receipt lines.
  const surfaces = new Map<
    string,
    { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D }
  >();
  return {
    renderLine(text: string, o: RenderLineOptions): RasterSource {
      // JetBrains Mono advances ~0.6em per glyph. Size ASCII lines from the column
      // count so 32/48-column text lands on the same grid as the ESC/POS text path;
      // `maxWidth` alone would condense a fixed 24px line instead.
      const columns =
        o.charsPerLine ?? Math.max(1, Math.round(o.dots / (o.rtl ? 20 : 12)));
      const px = o.rtl
        ? PX[o.size]
        : Math.max(8, Math.floor(o.dots / (columns * 0.6)));
      const tall = o.size === 'double-height' ? 2 : 1;
      const height = Math.ceil(px * (o.rtl ? 1.7 : 1.25)) * tall;
      const key = `${o.dots}x${height}`;
      let surface = surfaces.get(key);
      if (!surface) {
        const canvas = doc.createElement('canvas');
        canvas.width = o.dots;
        canvas.height = height;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) throw new Error('canvas unavailable');
        surface = { canvas, ctx };
        surfaces.set(key, surface);
      }
      const { ctx } = surface;
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, o.dots, height);
      ctx.fillStyle = '#000';
      ctx.textBaseline = 'middle';
      // Draw explicit pair/item cells at real column boundaries. Space padding in a
      // proportional Urdu font collapses the columns on these rows.
      const drawCell = (
        value: string,
        cellX: number,
        cellAlign: CanvasTextAlign,
        cellRtl: boolean,
      ): void => {
        ctx.save();
        ctx.scale(1, tall);
        ctx.font = `${o.bold ? 700 : 400} ${px}px ${
          cellRtl
            ? "'Noto Naskh Arabic UI', serif"
            : "'JetBrains Mono', ui-monospace, monospace"
        }`;
        ctx.direction = cellRtl ? 'rtl' : 'ltr';
        ctx.textAlign = cellAlign;
        ctx.fillText(value, cellX, height / tall / 2, Math.max(1, o.dots));
        ctx.restore();
      };
      if (o.cells !== undefined && o.cells.length > 0) {
        const cells = o.cells;
        if (cells.length > 2) {
          const chars = o.charsPerLine ?? 48;
          const widths = columnWidths(chars);
          const amountPx = (o.dots * widths.amount) / chars;
          if (o.rtl) {
            drawCell(cells[2]?.text ?? '', 0, 'left', false);
            drawCell(
              cells[1]?.text ?? '',
              amountPx,
              'left',
              lineNeedsRtl(cells[1]?.text ?? ''),
            );
            drawCell(
              cells[0]?.text ?? '',
              o.dots,
              'right',
              lineNeedsRtl(cells[0]?.text ?? ''),
            );
          } else {
            drawCell(
              cells[0]?.text ?? '',
              0,
              'left',
              lineNeedsRtl(cells[0]?.text ?? ''),
            );
            drawCell(
              cells[1]?.text ?? '',
              o.dots - amountPx,
              'right',
              lineNeedsRtl(cells[1]?.text ?? ''),
            );
            drawCell(cells[2]?.text ?? '', o.dots, 'right', false);
          }
        } else {
          const left = cells[0];
          const right = cells[1];
          const leftRtl = lineNeedsRtl(left?.text ?? '');
          const rightRtl = lineNeedsRtl(right?.text ?? '');
          if (o.rtl) {
            drawCell(left?.text ?? '', o.dots, 'right', leftRtl);
            drawCell(right?.text ?? '', 0, 'left', rightRtl);
          } else {
            drawCell(left?.text ?? '', 0, 'left', leftRtl);
            drawCell(right?.text ?? '', o.dots, 'right', rightRtl);
          }
        }
      } else {
        ctx.font = `${o.bold ? 700 : 400} ${px}px ${
          o.rtl
            ? "'Noto Naskh Arabic UI', serif"
            : "'JetBrains Mono', ui-monospace, monospace"
        }`;
        ctx.direction = o.rtl ? 'rtl' : 'ltr';
        const align = o.rtl && o.align === 'left' ? 'right' : o.align;
        ctx.textAlign = align;
        const x =
          align === 'center' ? o.dots / 2 : align === 'right' ? o.dots : 0;
        ctx.save();
        ctx.scale(1, tall);
        // Keep deliberate leading spaces (bundle component indentation); maxWidth
        // condenses a too-wide Urdu line instead of clipping it.
        ctx.fillText(text, x, height / tall / 2, Math.max(1, o.dots));
        ctx.restore();
      }
      const data = ctx.getImageData(0, 0, o.dots, height).data;
      return { width: o.dots, height, data, format: 'rgba' };
    },
  };
}
