import type {
  RasterRenderer,
  RasterSource,
  RenderLineOptions,
} from './types.ts';

/**
 * Deterministic stand-in for OffscreenCanvas.
 * Each character paints a column from its low 8 bits. Bold darkens the next
 * column. RTL forces the top-left pixel black so Urdu lines differ from ASCII.
 * Height is 8 px, 6 for small (about 70 %), or 16 when the line is double or double-height.
 */
export function createFakeRasterRenderer(): RasterRenderer {
  return {
    renderLine(text: string, options: RenderLineOptions): RasterSource {
      const width = options.dots;
      const height =
        options.size === 'normal' ? 8 : options.size === 'small' ? 6 : 16;
      if (width < 1 || height < 1) {
        throw new Error('fake renderer needs a positive size');
      }
      const data = new Uint8Array(width * height);
      data.fill(255);
      if (options.rtl) {
        data[0] = 0;
      }
      const origin =
        options.align === 'center'
          ? Math.floor(width / 2)
          : options.align === 'right'
            ? width - 1
            : 0;
      for (let i = 0; i < text.length; i += 1) {
        const code = (text.charCodeAt(i) ?? 0) & 0xff;
        const x =
          options.align === 'left'
            ? i % width
            : options.align === 'right'
              ? (width - 1 - (i % width) + width) % width
              : (origin + i) % width;
        for (let bit = 0; bit < 8 && bit < height; bit += 1) {
          if ((code & (1 << bit)) !== 0) {
            data[bit * width + x] = 0;
          }
        }
        if (options.bold) {
          data[Math.min(width - 1, x + 1)] = 0;
        }
      }
      return { width, height, data, format: 'gray' };
    },
  };
}
