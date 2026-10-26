import { describe, expect, it } from 'vitest';
import { packageName } from './index.ts';

describe('@bikri/tools', () => {
  it('exposes its package name', () => {
    expect(packageName).toBe('@bikri/tools');
  });
});
