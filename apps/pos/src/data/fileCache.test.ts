import { BASE_PATH } from '@bikri/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearFileUrls,
  FILE_URL_CACHE_MAX,
  fileCacheUrl,
  fileUrlFor,
  putFile,
} from './fileCache.ts';

afterEach(() => vi.unstubAllGlobals());

describe('file cache keys', () => {
  it('uses BASE_PATH, keeps the tenant, and cannot escape its namespace', () => {
    const url = fileCacheUrl('t1', 'products/p1/photo.webp');
    expect(url).toContain(`${BASE_PATH}/__files/t1/products/p1/photo.webp`);
    expect(() => fileCacheUrl('t1', '../t2/products/p1/photo.webp')).toThrow(
      'invalid file key',
    );
  });

  it('retries caches.open after a rejection instead of caching it (SYNC-L4)', async () => {
    let opens = 0;
    const store = {
      put: async () => undefined,
      match: async () => undefined,
      delete: async () => true,
      keys: async () => [],
    };
    vi.stubGlobal('caches', {
      open: async () => {
        opens += 1;
        if (opens === 1) throw new Error('SecurityError');
        return store;
      },
    });
    await expect(putFile('t3', 'k', new Blob(['x']))).rejects.toThrow(
      'SecurityError',
    );
    await expect(putFile('t3', 'k', new Blob(['x']))).resolves.toBeUndefined();
    expect(opens).toBe(2);
  });
});

describe('file URL cache', () => {
  it('retries misses and failures, and reuses a successful URL', async () => {
    const create = vi.fn((blob: Blob) => `blob:${blob.size}`);
    const revoke = vi.fn();
    class FakeURL extends URL {
      static createObjectURL = create;
      static revokeObjectURL = revoke;
    }
    vi.stubGlobal('URL', FakeURL);

    let misses = 0;
    const miss = async () => {
      misses += 1;
      return null;
    };
    expect(await fileUrlFor('t1', 'missing', miss)).toBeNull();
    expect(await fileUrlFor('t1', 'missing', miss)).toBeNull();
    expect(misses).toBe(2);

    const fail = vi.fn(async () => {
      throw new Error('offline');
    });
    await expect(fileUrlFor('t1', 'failed', fail)).rejects.toThrow('offline');
    await expect(fileUrlFor('t1', 'failed', fail)).rejects.toThrow('offline');
    expect(fail).toHaveBeenCalledTimes(2);

    const blob = new Blob(['abc']);
    const hit = vi.fn(async () => blob);
    expect(await fileUrlFor('t1', 'hit', hit)).toBe('blob:3');
    expect(await fileUrlFor('t1', 'hit', hit)).toBe('blob:3');
    expect(hit).toHaveBeenCalledTimes(1);
    clearFileUrls('t1');
    await Promise.resolve();
    expect(revoke).toHaveBeenCalledWith('blob:3');
  });

  it('bounds the object-URL cache and revokes the evicted URL', async () => {
    const create = vi.fn((blob: Blob) => `blob:${blob.size}`);
    const revoke = vi.fn();
    class FakeURL extends URL {
      static createObjectURL = create;
      static revokeObjectURL = revoke;
    }
    vi.stubGlobal('URL', FakeURL);
    try {
      for (let index = 0; index < FILE_URL_CACHE_MAX + 1; index += 1) {
        await fileUrlFor(
          't2',
          `k${index}`,
          async () => new Blob(['x'.repeat(index + 1)]),
        );
      }
      await Promise.resolve();
      expect(create).toHaveBeenCalledTimes(FILE_URL_CACHE_MAX + 1);
      expect(revoke).toHaveBeenCalledWith('blob:1');
    } finally {
      clearFileUrls('t2');
    }
  });
});
