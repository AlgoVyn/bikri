import { describe, expect, it } from 'vitest';
import { packageName } from './index.ts';

describe('@bikri/i18n', () => {
  it('exposes its package name', () => {
    expect(packageName).toBe('@bikri/i18n');
  });
});
