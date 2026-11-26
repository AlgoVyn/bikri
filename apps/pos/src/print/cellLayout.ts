/** Canvas column boxes shared by the thermal raster and the shared picture. */
import { columnWidths, type LaidCell, lineNeedsRtl } from '@bikri/printer';

export type CellBox = {
  text: string;
  /** Left edge in receipt-local dots (0 is the printable left edge). */
  x: number;
  align: 'left' | 'right';
  /** Maximum drawn width for this column, in dots. */
  maxWidth: number;
  rtl: boolean;
};

type Box = (cells: readonly LaidCell[], index: number) => CellBox;

/**
 * Places a laid-out row in receipt order (name, qty, amount) regardless of the
 * line direction. HTML/preview use the same LTR grid; Urdu stays a per-cell
 * direction and font, never a reason to reverse the columns. Each cell is
 * bounded to its real column width so a wide Urdu cell cannot run into the
 * neighbouring column.
 */
export function cellBoxes(
  cells: readonly LaidCell[],
  dots: number,
  charsPerLine: number,
): CellBox[] {
  const width = Math.max(1, dots);
  const box: Box = (list, index) => {
    const text = list[index]?.text ?? '';
    return {
      text,
      x: 0,
      align: 'left',
      maxWidth: width,
      rtl: lineNeedsRtl(text),
    };
  };
  if (cells.length > 2) {
    const chars =
      Number.isInteger(charsPerLine) && charsPerLine >= 24 ? charsPerLine : 48;
    const widths = columnWidths(chars);
    const amountPx = (width * widths.amount) / chars;
    const qtyPx = (width * widths.qty) / chars;
    return [
      {
        ...box(cells, 0),
        maxWidth: Math.max(1, width - amountPx - qtyPx),
      },
      {
        ...box(cells, 1),
        x: width - amountPx,
        align: 'right',
        maxWidth: Math.max(1, qtyPx),
      },
      {
        ...box(cells, 2),
        x: width,
        align: 'right',
        maxWidth: Math.max(1, amountPx),
      },
    ];
  }
  const leftWidth = Math.max(1, Math.floor(width * 0.6));
  return [
    { ...box(cells, 0), maxWidth: leftWidth },
    ...(cells.length > 1
      ? [
          {
            ...box(cells, 1),
            x: width,
            align: 'right' as const,
            maxWidth: Math.max(1, width - leftWidth),
          },
        ]
      : []),
  ];
}
