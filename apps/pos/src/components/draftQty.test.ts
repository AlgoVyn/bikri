import { describe, expect, it } from 'vitest';
import { draftQty } from './draftQty.ts';

describe('draft line quantities (UI-H4)', () => {
  it('treats an empty or non-positive draft as zero without snapping the field', () => {
    expect(draftQty(null)).toBe(0);
    expect(draftQty(0)).toBe(0);
    expect(draftQty(-500)).toBe(0);
    expect(draftQty(1.5)).toBe(0);
    expect(draftQty(500)).toBe(500);
    expect(draftQty(1000)).toBe(1000);
  });
});
