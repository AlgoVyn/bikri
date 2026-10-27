import type { BikriDb } from '@bikri/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  encodeUnderLimit,
  PHOTO_MAX_BYTES,
  PhotoError,
  photoKey,
  sha256Hex,
  squareCrop,
} from '../products/photo.ts';
import { ledgerContext, saveNewProduct, saveProductEdit } from './catalog.ts';
import {
  clearTenantFiles,
  deleteFile,
  FILE_CACHE_MAX,
  fileCacheUrl,
  getFile,
  putFile,
} from './fileCache.ts';
import { dropTestDbs, freshDb } from './testDb.ts';

/** Minimal in-memory Cache Storage (jsdom has none). */
class FakeCache {
  readonly map = new Map<string, Response>();
  async put(url: string, res: Response) {
    this.map.set(url, res);
  }
  async match(url: string) {
    return this.map.get(url)?.clone();
  }
  async delete(req: string | { url: string }) {
    return this.map.delete(typeof req === 'string' ? req : req.url);
  }
  async keys() {
    return [...this.map.keys()].map((url) => ({ url }));
  }
}
let cache: FakeCache;
beforeEach(() => {
  cache = new FakeCache();
  Object.assign(globalThis, { caches: { open: async () => cache } });
});
afterEach(async () => {
  Reflect.deleteProperty(globalThis, 'caches');
  await dropTestDbs();
});

const NOW = Date.UTC(2026, 9, 27, 9, 0);
const row = { created_at: NOW, updated_at: NOW, deleted_at: null, rev: 1 };

async function readyDb(prefix = 'ph'): Promise<BikriDb> {
  const db = freshDb(prefix);
  await db.branches.add({
    id: 'br-1',
    name: 'Main',
    bill_prefix: 'A',
    is_default: 1,
    ...row,
  });
  await db.kv.put({
    key: 'device',
    value: {
      id: 'dev-1',
      name: 'C1',
      code: 'A',
      branch_id: 'br-1',
      is_admin: true,
    },
  });
  return db;
}

const blob = (n: number, type = 'image/webp') =>
  new Blob([new Uint8Array(n)], { type });

describe('photo processing (screens/08)', () => {
  it('crops the centre square and builds a tenant-free key', () => {
    expect(squareCrop(1200, 800)).toEqual({ sx: 200, sy: 0, side: 800 });
    expect(squareCrop(600, 900)).toEqual({ sx: 0, sy: 150, side: 600 });
    expect(photoKey('P1', { sha256: 'ab', ext: 'webp' })).toBe(
      'products/P1/ab.webp',
    );
  });

  it('lowers quality until ≤ 150 KB and falls back to JPEG without WebP', async () => {
    const tries: string[] = [];
    const out = await encodeUnderLimit(async (type, q) => {
      tries.push(`${type}@${q}`);
      return blob(q > 0.6 ? PHOTO_MAX_BYTES + 1 : 1000, type);
    });
    expect(out.ext).toBe('webp');
    expect(tries).toEqual([
      'image/webp@0.8',
      'image/webp@0.7',
      'image/webp@0.6',
    ]);
    const jpg = await encodeUnderLimit(async (type) =>
      blob(1000, type === 'image/webp' ? 'image/png' : type),
    );
    expect(jpg.ext).toBe('jpg');
    const big = await encodeUnderLimit(async (type) =>
      blob(PHOTO_MAX_BYTES * 2, type),
    );
    expect(big.blob.size).toBe(PHOTO_MAX_BYTES * 2);
    await expect(encodeUnderLimit(async () => null)).rejects.toBeInstanceOf(
      PhotoError,
    );
  });

  it('hashes with SHA-256', async () => {
    expect(await sha256Hex(new Blob(['abc']))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});

describe('file cache (01 §PWA, D-092)', () => {
  it('stores per tenant, so colliding keys in two shops never mix', async () => {
    await putFile('shop-a', 'products/P1/x.webp', blob(10));
    expect((await getFile('shop-a', 'products/P1/x.webp'))?.size).toBe(10);
    expect(await getFile('shop-b', 'products/P1/x.webp')).toBeNull();
    expect(fileCacheUrl('shop-a', 'k')).not.toBe(fileCacheUrl('shop-b', 'k'));
    await putFile('shop-b', 'products/P1/x.webp', blob(20));
    await clearTenantFiles('shop-a');
    expect(await getFile('shop-a', 'products/P1/x.webp')).toBeNull();
    expect((await getFile('shop-b', 'products/P1/x.webp'))?.size).toBe(20);
    await deleteFile('shop-b', 'products/P1/x.webp');
    expect(await getFile('shop-b', 'products/P1/x.webp')).toBeNull();
  });

  it(`keeps at most ${FILE_CACHE_MAX} entries, dropping the oldest`, async () => {
    for (let i = 0; i < FILE_CACHE_MAX + 2; i += 1)
      await cache.put(`u${i}`, new Response('x'));
    await putFile('a', 'k', blob(1));
    expect(cache.map.size).toBe(FILE_CACHE_MAX);
    expect(cache.map.has('u0')).toBe(false);
  });

  it('does nothing without Cache Storage', async () => {
    Reflect.deleteProperty(globalThis, 'caches');
    await putFile('a', 'k', blob(1));
    expect(await getFile('a', 'k')).toBeNull();
    await deleteFile('a', 'k');
    await clearTenantFiles('a');
  });
});

describe('saving a product photo (T-015)', () => {
  it('stores image_key, queues the upload in the same action and caches the file', async () => {
    const db = await readyDb();
    const ctx = await ledgerContext(db, 'st-1');
    const photo = {
      blob: blob(500),
      sha256: 'f'.repeat(64),
      ext: 'webp' as const,
    };
    const p = await saveNewProduct(
      db,
      { name_en: 'Earbuds', price: 1, photo },
      ctx,
    );
    expect(p.image_key).toBe(`products/${p.id}/${'f'.repeat(64)}.webp`);
    const queued = await db.file_queue.toArray();
    expect(queued).toMatchObject([
      {
        kind: 'product_image',
        target_id: p.id,
        sha256: 'f'.repeat(64),
        status: 'pending',
      },
    ]);
    expect((await getFile(db.tenantId, String(p.image_key)))?.size).toBe(500);
    const op = (await db.outbox.toArray()).find((o) => o.tbl === 'products');
    expect(op?.row?.image_key).toBe(p.image_key);
    expect(JSON.stringify(op?.row)).not.toContain(db.tenantId);

    const next = {
      blob: blob(600),
      sha256: 'e'.repeat(64),
      ext: 'webp' as const,
    };
    await saveProductEdit(
      db,
      p.id,
      { name_en: 'Earbuds', price: 1, photo: next },
      ctx,
    );
    expect((await db.products.get(p.id))?.image_key).toBe(
      `products/${p.id}/${'e'.repeat(64)}.webp`,
    );
    expect(await db.file_queue.count()).toBe(2);
    await saveProductEdit(
      db,
      p.id,
      { name_en: 'Earbuds', price: 1, photo: null },
      ctx,
    );
    expect((await db.products.get(p.id))?.image_key).toBeNull();
    await saveProductEdit(db, p.id, { name_en: 'Earbuds', price: 2 }, ctx);
    expect((await db.products.get(p.id))?.image_key).toBeNull();
  });

  it("one shop's photo never shows in another shop with the same product id", async () => {
    const a = await readyDb('pa');
    const b = await readyDb('pb');
    const photo = {
      blob: blob(5),
      sha256: 'a'.repeat(64),
      ext: 'webp' as const,
    };
    const pa = await saveNewProduct(
      a,
      { id: 'SAME', name_en: 'X', price: 1, photo },
      await ledgerContext(a, 's'),
    );
    const pb = await saveNewProduct(
      b,
      { id: 'SAME', name_en: 'X', price: 1 },
      await ledgerContext(b, 's'),
    );
    expect(pb.image_key).toBeNull();
    expect(await getFile(b.tenantId, String(pa.image_key))).toBeNull();
    expect(await b.file_queue.count()).toBe(0);
  });
});
