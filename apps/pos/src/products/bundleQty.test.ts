import { describe, expect, it } from 'vitest';
import { bundleQtyValid, clampBundleQty, minBundleQty } from './bundleQty.ts';

describe('bundle recipe quantities (UI-H4)', () => {
  it('allows a fractional quantity below 1 for a decimal unit', () => {
    expect(minBundleQty('kg')).toBe(1);
    expect(clampBundleQty(500, 'kg')).toBe(500);
    expect(clampBundleQty(0, 'kg')).toBe(1);
    expect(bundleQtyValid(500, 'kg')).toBe(true);
  });

  it('keeps whole pieces for an integer unit', () => {
    expect(minBundleQty('pc')).toBe(1000);
    expect(clampBundleQty(0, 'pc')).toBe(1000);
    expect(clampBundleQty(1500, 'pc')).toBe(1000);
    expect(clampBundleQty(2500, 'pc')).toBe(2000);
    expect(bundleQtyValid(2000, 'pc')).toBe(true);
    expect(bundleQtyValid(500, 'pc')).toBe(false);
    expect(bundleQtyValid(0, 'kg')).toBe(false);
  });
});
