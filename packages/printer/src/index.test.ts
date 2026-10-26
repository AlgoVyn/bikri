import { describe, expect, it } from 'vitest';
import { packageName } from './index.ts';

describe('@bikri/printer', () => {
  it('exposes its package name', () => {
    expect(packageName).toBe('@bikri/printer');
  });
});
