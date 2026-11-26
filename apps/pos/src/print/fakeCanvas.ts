/** A recording canvas document for the receipt raster tests. */
import type { RasterSource } from '@bikri/printer';

export type DrawCall = {
  text: string;
  x: number;
  y: number;
  maxWidth: number;
  align: CanvasTextAlign;
  direction: CanvasDirection;
  font: string;
};

type TextState = {
  align: CanvasTextAlign;
  direction: CanvasDirection;
  font: string;
};

export function fakeCanvasDocument(): {
  doc: Document;
  calls: DrawCall[];
} {
  const calls: DrawCall[] = [];
  let state: TextState = {
    align: 'start',
    direction: 'ltr',
    font: '24px',
  };
  const stack: TextState[] = [];
  const ctx = {
    fillStyle: '',
    textBaseline: '',
    get textAlign(): CanvasTextAlign {
      return state.align;
    },
    set textAlign(value: CanvasTextAlign) {
      state.align = value;
    },
    get direction(): CanvasDirection {
      return state.direction;
    },
    set direction(value: CanvasDirection) {
      state.direction = value;
    },
    get font(): string {
      return state.font;
    },
    set font(value: string) {
      state.font = value;
    },
    save(): void {
      stack.push({ ...state });
    },
    restore(): void {
      const previous = stack.pop();
      if (previous) state = previous;
    },
    scale(): void {},
    translate(): void {},
    fillRect(): void {},
    createImageData(width: number, height: number) {
      return {
        width,
        height,
        data: new Uint8ClampedArray(width * height * 4),
      };
    },
    putImageData(_source: RasterSource, _x: number, _y: number): void {},
    fillText(text: string, x: number, y: number, maxWidth?: number): void {
      calls.push({
        text,
        x,
        y,
        maxWidth: maxWidth ?? 0,
        align: state.align,
        direction: state.direction,
        font: state.font,
      });
    },
    getImageData(_x: number, _y: number, width: number, height: number) {
      return {
        width,
        height,
        data: new Uint8ClampedArray(width * height * 4),
      };
    },
  };
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => ctx,
  };
  const doc = {
    createElement: () => canvas,
  } as unknown as Document;
  return { doc, calls };
}
