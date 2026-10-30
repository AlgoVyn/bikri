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
  await Promise.all([
    fonts.load('400 24px "Noto Nastaliq Urdu"'),
    fonts.load('700 24px "Noto Nastaliq Urdu"'),
    fonts.load('400 24px Inter'),
    fonts.load('700 24px Inter'),
  ]).catch(() => undefined);
}

export function createCanvasRasterRenderer(
  doc: Document = document,
): RasterRenderer {
  const canvas = doc.createElement('canvas');
  return {
    renderLine(text: string, o: RenderLineOptions): RasterSource {
      const px = PX[o.size];
      const tall = o.size === 'double-height' ? 2 : 1;
      const height = Math.ceil(px * (o.rtl ? 1.9 : 1.25)) * tall;
      canvas.width = o.dots;
      canvas.height = height;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) throw new Error('canvas unavailable');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, o.dots, height);
      ctx.fillStyle = '#000';
      ctx.textBaseline = 'middle';
      ctx.font = `${o.bold ? 700 : 400} ${px}px ${o.rtl ? "'Noto Nastaliq Urdu', serif" : 'Inter, sans-serif'}`;
      ctx.direction = o.rtl ? 'rtl' : 'ltr';
      const align = o.rtl && o.align === 'left' ? 'right' : o.align;
      ctx.textAlign = align;
      const x =
        align === 'center' ? o.dots / 2 : align === 'right' ? o.dots : 0;
      ctx.save();
      ctx.scale(1, tall);
      ctx.fillText(text.trim(), x, height / tall / 2);
      ctx.restore();
      const data = ctx.getImageData(0, 0, o.dots, height).data;
      return { width: o.dots, height, data, format: 'rgba' };
    },
  };
}
