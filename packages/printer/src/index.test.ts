import { describe, expect, it } from 'vitest';
import {
  encodeEscPos,
  PAPER_PRESETS,
  packageName,
  saleBasicInput,
} from './index.ts';

describe('@bikri/printer', () => {
  it('exposes its package name', () => {
    expect(packageName).toBe('@bikri/printer');
  });

  it('defaults to 80 mm and keeps 58 mm at 32 / 384', () => {
    expect(PAPER_PRESETS[80]).toMatchObject({
      charsPerLine: 48,
      dots: 576,
      bytesPerRow: 72,
    });
    expect(PAPER_PRESETS[58]).toMatchObject({
      charsPerLine: 32,
      dots: 384,
      bytesPerRow: 48,
    });
    expect(saleBasicInput().shop.name).toBe('Algovyn Mobiles');
    const bytes = encodeEscPos([{ t: 'text', text: 'Hi' }], {
      charsPerLine: 32,
      dots: 384,
    });
    expect(bytes[0]).toBe(0x1b);
    expect(bytes[1]).toBe(0x40);
  });
});
