/** Browser text rasteriser for Urdu / non-ASCII receipt lines (06 §6). */
import type {
  RasterRenderer,
  RasterSource,
  RenderLineOptions,
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
      const px = PX[o.size];
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
      // ASCII lines are column-aligned; use the same monospace face as the PNG path.
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
      const data = ctx.getImageData(0, 0, o.dots, height).data;
      return { width: o.dots, height, data, format: 'rgba' };
    },
  };
}
