import { BASE_PATH } from '@bikri/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearFileUrls,
  deleteFile,
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

  it('does not list the cache on the first put of a session', async () => {
    let keyCalls = 0;
    const store = {
      put: async () => undefined,
      match: async () => undefined,
      delete: async () => true,
      keys: async () => {
        keyCalls += 1;
        return [];
      },
    };
    vi.stubGlobal('caches', { open: async () => store });
    await putFile('t-first', 'k', new Blob(['x']));
    expect(keyCalls).toBe(0);
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

  it('does not drop a newer in-flight request when an older one misses', async () => {
    const create = vi.fn((blob: Blob) => `blob:${blob.size}`);
    class FakeURL extends URL {
      static createObjectURL = create;
      static revokeObjectURL = vi.fn();
    }
    vi.stubGlobal('URL', FakeURL);

    let resolveFirst: (blob: Blob | null) => void = () => undefined;
    const first = fileUrlFor(
      't4',
      'race',
      () =>
        new Promise<Blob | null>((resolve) => {
          resolveFirst = resolve;
        }),
    );
    clearFileUrls('t4');
    let resolveSecond: (blob: Blob | null) => void = () => undefined;
    const second = fileUrlFor(
      't4',
      'race',
      () =>
        new Promise<Blob | null>((resolve) => {
          resolveSecond = resolve;
        }),
    );
    resolveFirst(null);
    await expect(first).resolves.toBeNull();
    // The miss of the removed request must not delete the newer promise.
    let loads = 0;
    const third = fileUrlFor('t4', 'race', async () => {
      loads += 1;
      return new Blob(['zzz']);
    });
    expect(third).toBe(second);
    resolveSecond(new Blob(['ab']));
    await expect(second).resolves.toBe('blob:2');
    expect(loads).toBe(0);
    clearFileUrls('t4');
  });

  it('revokes the cached URL when a file is deleted', async () => {
    const create = vi.fn((blob: Blob) => `blob:${blob.size}`);
    const revoke = vi.fn();
    class FakeURL extends URL {
      static createObjectURL = create;
      static revokeObjectURL = revoke;
    }
    vi.stubGlobal('URL', FakeURL);
    const deletes: string[] = [];
    vi.stubGlobal('caches', {
      open: async () => ({
        put: async () => undefined,
        match: async () => undefined,
        delete: async (request: string) => {
          deletes.push(request);
          return true;
        },
        keys: async () => [],
      }),
    });
    await expect(
      fileUrlFor('t5', 'photo', async () => new Blob(['abc'])),
    ).resolves.toBe('blob:3');
    await deleteFile('t5', 'photo');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(revoke).toHaveBeenCalledWith('blob:3');
    expect(deletes).toHaveLength(1);
    expect(deletes[0]).toContain('/__files/t5/photo');
  });
});
