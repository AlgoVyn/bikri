import { describe, expect, it } from 'vitest';
import { contrastRatio } from './contrast.ts';
import { TILE_RATIO_RANGE, tokenPairs } from './tokenPairs.ts';

describe('contrastRatio', () => {
  it('matches every documented token pair within ±0.02 and its threshold', () => {
    for (const pair of tokenPairs) {
      const actual = contrastRatio(pair.fg, pair.bg);
      expect(
        Math.abs(actual - pair.ratio),
        `${pair.name} measured ${actual.toFixed(2)} vs ${pair.ratio}`,
      ).toBeLessThanOrEqual(0.02);
      expect(actual, pair.name).toBeGreaterThanOrEqual(pair.needed);
    }
  });

  it('keeps white tile text inside the documented 5.02–13.45 band', () => {
    const tiles = tokenPairs.filter((pair) => pair.name.startsWith('tile '));
    expect(tiles).toHaveLength(8);
    for (const pair of tiles) {
      const actual = contrastRatio(pair.fg, pair.bg);
      expect(actual).toBeGreaterThanOrEqual(TILE_RATIO_RANGE.min - 0.02);
      expect(actual).toBeLessThanOrEqual(TILE_RATIO_RANGE.max + 0.02);
      expect(pair.fg).toBe('#FFFFFF');
    }
  });

  it('is symmetric', () => {
    expect(contrastRatio('#006BB3', '#FFFFFF')).toBeCloseTo(
      contrastRatio('#FFFFFF', '#006BB3'),
      10,
    );
  });
});
