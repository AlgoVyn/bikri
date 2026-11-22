import { describe, expect, it, vi } from 'vitest';
import { receiptPaper } from '../data/receipt.ts';
import { receiptPdf } from './receiptFiles.ts';

// A real canvas is unavailable in jsdom; the size is what this test cares about.
const { fakeCanvas } = vi.hoisted(() => ({
  fakeCanvas: {
    width: 608,
    height: 400,
    toBlob: (callback: (blob: Blob | null) => void) =>
      callback(
        new Blob([new Uint8Array([0xff, 0xd8, 1, 2, 0xff, 0xd9])], {
          type: 'image/jpeg',
        }),
      ),
  },
}));

vi.mock('./receiptImage.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./receiptImage.ts')>();
  return {
    ...actual,
    renderReceiptCanvas: vi.fn(
      async () => fakeCanvas as unknown as HTMLCanvasElement,
    ),
  };
});

describe('receipt PDF (screens/07 AC 2)', () => {
  it('uses the full rendered canvas width, not the narrowed print area', async () => {
    // 80 mm paper still set to 32 columns: the 576-dot canvas is centred and
    // `printWidthMm` is 48 mm. Mapping the 608 px canvas to 48 mm shrank the
    // PDF text to ~30 mm; 608 px / 8 px per mm = 76 mm = 215.43 pt.
    const paper = receiptPaper({ paper_mm: 80, chars_per_line: 32, dots: 384 });
    const pdf = await receiptPdf({
      blocks: [],
      paper,
      logo: null,
      printer: null,
    });
    const text = new TextDecoder('latin1').decode(
      new Uint8Array(await pdf.arrayBuffer()),
    );
    expect(text).toContain('/MediaBox [0 0 215.43');
    expect(text).not.toContain('/MediaBox [0 0 136.06');
  });
});
