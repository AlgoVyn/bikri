import { createHash } from 'node:crypto';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildFileManifest, isFileKey, main, withRetry } from './files.mjs';

const T1 = '01JC0000000000000000000001';
const P1 = '01JC0000000000000000000002';
const T2 = '01JC0000000000000000000003';
const K1 = `t/${T1}/products/${P1}/${'a'.repeat(64)}.webp`;
const K2 = `t/${T2}/shop/logo-${'b'.repeat(64)}.png`;

const json = (body) =>
  new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
  });

let dirs = [];

async function tempDir() {
  const dir = await mkdtemp(join(tmpdir(), 'bikri-files-'));
  dirs.push(dir);
  return dir;
}

function page(objects, cursor) {
  return json({
    success: true,
    result: objects,
    result_info: cursor
      ? { is_truncated: true, cursor }
      : { is_truncated: false },
  });
}

beforeEach(() => {
  process.env.CLOUDFLARE_ACCOUNT_ID = 'acct';
  process.env.CLOUDFLARE_API_TOKEN = 'token';
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.CLOUDFLARE_ACCOUNT_ID;
  delete process.env.CLOUDFLARE_API_TOKEN;
  await Promise.all(
    dirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
  dirs = [];
});

describe('file backup keys', () => {
  it('accepts tenant files and rejects anything that can escape the output', () => {
    expect(isFileKey(K1)).toBe(true);
    expect(isFileKey(K2)).toBe(true);
    expect(isFileKey(`t/${T1}/custom/a.txt`)).toBe(true);
    expect(isFileKey(`t/${T1}`)).toBe(false);
    expect(isFileKey(`t/${T1}/../${K1}`)).toBe(false);
    expect(isFileKey(`t/${T1}/a\\b`)).toBe(false);
    expect(isFileKey(`/t/${T1}/a`)).toBe(false);
    expect(isFileKey('t/not-a-tenant/a')).toBe(false);
    expect(isFileKey(`t/${T1}//a`)).toBe(false);
    expect(isFileKey(`t/${T1}/a\u0000b`)).toBe(false);
  });
});

describe('file manifest', () => {
  it('aggregates per tenant, totals bytes and sorts by key', () => {
    const manifest = buildFileManifest({
      date: '2026-11-01',
      bucket: 'bikri-files',
      generatedAt: 1,
      files: [
        { key: K2, bytes: 2, sha256: 'b', etag: 'e2' },
        { key: K1, bytes: 3, sha256: 'a', etag: 'e1' },
        {
          key: `t/${T1}/shop/logo-${'c'.repeat(64)}.png`,
          bytes: 4,
          sha256: 'c',
          etag: null,
        },
      ],
    });
    expect(manifest).toMatchObject({
      format: 'bikri-files',
      version: 1,
      date: '2026-11-01',
      bucket: 'bikri-files',
      generated_at: 1,
      objects: 3,
      bytes: 9,
    });
    expect(manifest.tenants[T1]).toEqual({ objects: 2, bytes: 7 });
    expect(manifest.tenants[T2]).toEqual({ objects: 1, bytes: 2 });
    expect(manifest.files.map((file) => file.key)).toEqual([
      K1,
      `t/${T1}/shop/logo-${'c'.repeat(64)}.png`,
      K2,
    ]);
  });
});

describe('weekly file backup', () => {
  it('pages the listing, downloads every file and writes a manifest without logging keys', async () => {
    const out = await tempDir();
    const bytes = new Map([
      [K1, new Uint8Array([1, 2, 3])],
      [K2, new Uint8Array([4, 5])],
    ]);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const calls = [];
    vi.stubGlobal('fetch', async (url) => {
      const u = String(url);
      calls.push(u);
      if (u.includes('/objects?'))
        return new URL(u).searchParams.get('cursor')
          ? page([{ key: K2, size: 2, etag: '"e2"' }])
          : page([{ key: K1, size: 3, etag: '"e1"' }], 'next');
      const key = u.endsWith(K1) ? K1 : u.endsWith(K2) ? K2 : null;
      if (!key) return new Response('missing', { status: 404 });
      return new Response(bytes.get(key));
    });

    const manifest = await main([
      '--out-dir',
      out,
      '--date',
      '2026-11-01',
      '--retry-base-ms',
      '0',
    ]);

    expect(manifest.objects).toBe(2);
    expect(manifest.bytes).toBe(5);
    expect(calls.filter((url) => url.includes('/objects?'))).toHaveLength(2);
    for (const [key, expected] of bytes) {
      const saved = await readFile(join(out, 'files', ...key.split('/')));
      expect(new Uint8Array(saved)).toEqual(expected);
      const entry = manifest.files.find((file) => file.key === key);
      expect(entry?.sha256).toBe(
        createHash('sha256').update(expected).digest('hex'),
      );
    }
    const written = JSON.parse(
      await readFile(join(out, 'files-2026-11-01.manifest.json'), 'utf8'),
    );
    expect(written).toEqual(manifest);
    const summary = log.mock.calls.flat().join(' ');
    expect(summary).toContain('"objects":2');
    expect(summary).not.toContain(T1);
    expect(summary).not.toContain(K1);
  });

  it('retries a 5xx download and gives up on a 404 without writing a manifest', async () => {
    const out = await tempDir();
    let attempts = 0;
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.stubGlobal('fetch', async (url) => {
      const u = String(url);
      if (u.includes('/objects?'))
        return page([{ key: K1, size: 3, etag: null }]);
      attempts += 1;
      if (attempts === 1) return new Response('retry', { status: 500 });
      return new Response(new Uint8Array([1, 2, 3]));
    });
    await expect(
      main(['--out-dir', out, '--date', '2026-11-01', '--retry-base-ms', '0']),
    ).resolves.toMatchObject({ objects: 1 });
    expect(attempts).toBe(2);

    attempts = 0;
    const failed = await tempDir();
    vi.stubGlobal('fetch', async (url) => {
      const u = String(url);
      if (u.includes('/objects?'))
        return page([{ key: K1, size: 3, etag: null }]);
      return new Response('missing', { status: 404 });
    });
    await expect(
      main([
        '--out-dir',
        failed,
        '--date',
        '2026-11-01',
        '--retry-base-ms',
        '0',
      ]),
    ).rejects.toThrow('HTTP 404');
    await expect(
      access(join(failed, 'files-2026-11-01.manifest.json')),
    ).rejects.toThrow();
  });

  it('lists without downloading on a dry run', async () => {
    const out = await tempDir();
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.stubGlobal('fetch', async (url) => {
      expect(String(url)).toContain('/objects?');
      return page([{ key: K1, size: 3, etag: null }]);
    });
    const result = await main([
      '--out-dir',
      out,
      '--date',
      '2026-11-01',
      '--dry-run',
    ]);
    expect(result).toEqual({ objects: 1, bytes: 3, tenants: 1, skipped: 0 });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('"dryRun":true'));
    await expect(access(join(out, 'files'))).rejects.toThrow();
  });

  it('refuses an unexpected key instead of silently skipping it', async () => {
    const out = await tempDir();
    vi.stubGlobal('fetch', async (url) =>
      String(url).includes('/objects?')
        ? page([{ key: `t/${T1}/../escape`, size: 1, etag: null }])
        : new Response('unexpected'),
    );
    await expect(
      main(['--out-dir', out, '--date', '2026-11-01', '--retry-base-ms', '0']),
    ).rejects.toThrow('Unexpected object key');
  });
});

describe('withRetry', () => {
  it('does not retry a permanent failure', async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls += 1;
          throw new Error('permanent');
        },
        { baseMs: 0 },
      ),
    ).rejects.toThrow('permanent');
    expect(calls).toBe(1);
  });
});
