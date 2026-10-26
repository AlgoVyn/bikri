/** Paper alignment. ESC/POS `1B 61 n`: 0 left, 1 centre, 2 right. */
export type Align = 'left' | 'center' | 'right';

/**
 * `double` is width and height (`1D 21 11`).
 * `double-height` is height only (`1D 21 01`) so a full-width total still fits.
 */
/** ESC/POS character font. B is about 3/4 the width of A. */
export type Font = 'A' | 'B';

export type TextSize = 'normal' | 'double' | 'double-height';

export type RasterFormat = 'rgba' | 'gray';

/** Unpacked bitmap. Gray is one byte per pixel; RGBA is four. 0 is black, 255 is white. */
export type RasterSource = {
  width: number;
  height: number;
  data: Uint8Array | Uint8ClampedArray;
  format: RasterFormat;
};

export type RenderLineOptions = {
  /** Paper width in dots (384 for 58 mm, 576 for 80 mm, overridable). */
  dots: number;
  align: Align;
  bold: boolean;
  size: TextSize;
  /** True when the line contains Arabic-script characters. */
  rtl: boolean;
};

/**
 * Browser seam for logo-independent text rasters.
 * The till implements this with OffscreenCanvas (Inter / Noto Nastaliq Urdu).
 * Node tests use {@link createFakeRasterRenderer}. Return gray or RGBA;
 * the encoder thresholds text at 50% luminance. Width should equal `dots`.
 */
export interface RasterRenderer {
  renderLine(text: string, options: RenderLineOptions): RasterSource;
}

/**
 * Ordered receipt blocks. The same list feeds ESC/POS, the text preview,
 * and (later) HTML / PNG. `breakdown` is the 58 mm qty line
 * (` 1 x 42,000 -2,000`); columns mode ignores it. `image` is an explicit
 * bitmap (tests and pre-rendered art).
 */
export type Block =
  | { t: 'logo' }
  | {
      t: 'text';
      text: string;
      align?: Align;
      bold?: boolean;
      size?: TextSize;
      /** Font B (`1B 4D 01`, 9×17 dots) for small print; default Font A (12×24). */
      font?: Font;
    }
  | {
      t: 'pair';
      left: string;
      right: string;
      bold?: boolean;
      size?: TextSize;
    }
  | {
      t: 'item';
      name: string;
      qty: string;
      amount: string;
      /** Columns mode: indented line under the item (`Rs 450 each`). */
      detail?: string;
      /** Stacked mode: left side of the qty line, leading space included. */
      breakdown?: string;
    }
  | { t: 'rule'; char: '-' | '=' }
  | { t: 'qr'; data: string }
  | { t: 'feed'; lines: number }
  | { t: 'cut' }
  | { t: 'drawer' }
  | { t: 'image'; source: RasterSource; dither?: boolean };

export type CutMode = 'partial' | 'full' | 'none';

export type ReceiptLanguage = 'en' | 'roman-ur' | 'ur';
