import { describe, expect, it } from 'vitest';
import {
  noteShareOpened,
  SHARE_SYNC_DEFER_MS,
  shareGraceActive,
} from './shareGrace.ts';

describe('share grace', () => {
  it('covers only the window after a share opens', () => {
    noteShareOpened(1_000);
    expect(shareGraceActive(1_000)).toBe(true);
    expect(shareGraceActive(1_000 + SHARE_SYNC_DEFER_MS - 1)).toBe(true);
    expect(shareGraceActive(1_000 + SHARE_SYNC_DEFER_MS)).toBe(false);
    expect(shareGraceActive(1_000 + SHARE_SYNC_DEFER_MS * 2)).toBe(false);
  });
});
