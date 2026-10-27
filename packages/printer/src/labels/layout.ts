import { type Code128, encodeCode128 } from './code128.ts';

export type LabelSizeId = '50x25' | '38x25' | '40x30' | 'a4';

export type LabelSize = {
  id: LabelSizeId;
  widthMm: number;
  heightMm: number;
  barHeightMm: number;
  columns: number;
  rows: number;
};

export const LABEL_SIZES: Record<LabelSizeId, LabelSize> = {
  '50x25': {
    id: '50x25',
    widthMm: 50,
    heightMm: 25,
    barHeightMm: 10,
    columns: 1,
    rows: 1,
  },
  '38x25': {
    id: '38x25',
    widthMm: 38,
    heightMm: 25,
    barHeightMm: 10,
    columns: 1,
    rows: 1,
  },
  '40x30': {
    id: '40x30',
    widthMm: 40,
    heightMm: 30,
    barHeightMm: 12,
    columns: 1,
    rows: 1,
  },
  a4: {
    id: 'a4',
    widthMm: 64,
    heightMm: 33.9,
    barHeightMm: 12,
    columns: 3,
    rows: 8,
  },
};

export type RenderDpi = 203 | 300;

export class LabelError extends Error {
  readonly code: 'too_long' | 'charset';
  constructor(code: LabelError['code']) {
    super(code);
    this.name = 'LabelError';
    this.code = code;
  }
}

/** Narrow bar in mm: whole printer dots, 3→2 at 203 dpi and 4→3 at 300 dpi. */
export function moduleMm(
  size: LabelSize,
  modules: number,
  dpi: RenderDpi = 203,
): number {
  const dots = dpi === 300 ? [4, 3] : [3, 2];
  for (const count of dots) {
    const mm = (count / dpi) * 25.4;
    if (modules * mm <= size.widthMm - 2) return mm;
  }
  throw new LabelError('too_long');
}

export type LabelCode = {
  code: Code128;
  size: LabelSize;
  dpi: RenderDpi;
  moduleMm: number;
  svg: string;
};

/** Barcode-only SVG in mm; the app lays the text around it (screens/20). */
export function barcodeLabelSvg(
  value: string,
  size: LabelSize,
  dpi: RenderDpi = 203,
): LabelCode {
  let code: Code128;
  try {
    code = encodeCode128(value);
  } catch {
    throw new LabelError('charset');
  }
  const mm = moduleMm(size, code.modules, dpi);
  const width = code.modules * mm;
  const left = (size.widthMm - width) / 2;
  const bars = code.bars
    .map(
      (bar) =>
        `<rect x="${(left + bar.x * mm).toFixed(3)}" y="0" width="${(bar.width * mm).toFixed(3)}" height="${size.barHeightMm}" />`,
    )
    .join('');
  return {
    code,
    size,
    dpi,
    moduleMm: mm,
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size.widthMm} ${size.barHeightMm}" width="${size.widthMm}mm" height="${size.barHeightMm}mm" shape-rendering="crispEdges" fill="black">${bars}</svg>`,
  };
}

/** A4 sheet cell order with a start-position skip (screens/20 AC 3). */
export function a4Slots(start = 0): { column: number; row: number }[] {
  const size = LABEL_SIZES.a4;
  const slots: { column: number; row: number }[] = [];
  for (let index = start; index < size.columns * size.rows; index += 1) {
    slots.push({
      column: index % size.columns,
      row: Math.floor(index / size.columns),
    });
  }
  return slots;
}
