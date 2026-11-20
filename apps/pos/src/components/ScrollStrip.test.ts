import { describe, expect, it } from 'vitest';
import { scrollMaskImage } from './ScrollStrip.tsx';

describe('scrollMaskImage', () => {
  it('does not fade a strip that fits', () => {
    expect(scrollMaskImage(0, 0, false)).toBeUndefined();
    expect(scrollMaskImage(0, 1, false)).toBeUndefined();
  });

  it('fades only the trailing edge at the start (LTR)', () => {
    expect(scrollMaskImage(0, 120, false)).toBe(
      'linear-gradient(to right, black calc(100% - 24px), transparent)',
    );
  });

  it('fades only the leading edge at the end (LTR)', () => {
    expect(scrollMaskImage(120, 120, false)).toBe(
      'linear-gradient(to right, transparent, black 24px)',
    );
  });

  it('fades both edges in the middle', () => {
    expect(scrollMaskImage(60, 120, false)).toBe(
      'linear-gradient(to right, transparent, black 24px, black calc(100% - 24px), transparent)',
    );
  });

  it('uses logical edges in RTL, where scrollLeft runs negative', () => {
    expect(scrollMaskImage(0, 120, true)).toBe(
      'linear-gradient(to left, black calc(100% - 24px), transparent)',
    );
    expect(scrollMaskImage(-120, 120, true)).toBe(
      'linear-gradient(to left, transparent, black 24px)',
    );
  });
});
