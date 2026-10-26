import { describe, expect, it } from 'vitest';
import { packageName } from './index.ts';

describe('@bikri/e2e', () => {
  it('exposes its package name', () => {
    expect(packageName).toBe('@bikri/e2e');
  });
});
