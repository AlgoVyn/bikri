import { BASE_PATH } from '@bikri/core';
import { describe, expect, it } from 'vitest';
import { fileCacheUrl } from './fileCache.ts';

describe('file cache keys', () => {
  it('uses BASE_PATH, keeps the tenant, and cannot escape its namespace', () => {
    const url = fileCacheUrl('t1', 'products/p1/photo.webp');
    expect(url).toContain(`${BASE_PATH}/__files/t1/products/p1/photo.webp`);
    expect(() => fileCacheUrl('t1', '../t2/products/p1/photo.webp')).toThrow(
      'invalid file key',
    );
  });
});
