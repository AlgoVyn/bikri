#!/usr/bin/env node
/**
 * Weekly R2 file backup (docs/09 §1 layer 7, §2.1): list every object under `t/` in the till
 * file bucket, download it and write a sha256 manifest. The workflow then tars and age-encrypts
 * the tree. Plain files stay on the runner; logs contain counts, never keys or tenant ids.
 *
 * Usage:
 *   node tools/backup/files.mjs --out-dir /tmp/files-backup [--date YYYY-MM-DD]
 *     [--bucket bikri-files] [--prefix t/] [--concurrency 8] [--dry-run]
 */
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  downloadObject,
  listObjects,
  R2DownloadError,
  r2Auth,
} from './cloudflare.mjs';
import { backupDate } from './export.mjs';

const DEFAULT_BUCKET = 'bikri-files';
const DEFAULT_PREFIX = 't/';
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/u;
const MAX_KEY = 1024;
const MAX_SEGMENT = 200;

function hasControl(value) {
  return Array.from(value).some((char) => {
    const code = char.codePointAt(0) ?? 0;
    return code < 32 || code === 127;
  });
}

/**
 * A key is `t/<tenant ULID>/...`, every segment is non-empty and nothing can escape the output
 * directory. The bucket is server-controlled, so future file kinds are copied without a new
 * regex here; the tenant segment and path safety are the invariants.
 */
export function isFileKey(key) {
  if (typeof key !== 'string' || key.length === 0 || key.length > MAX_KEY)
    return false;
  if (key.startsWith('/') || key.includes('\\')) return false;
  const parts = key.split('/');
  if (parts.length < 3 || parts[0] !== 't' || !ULID.test(parts[1]))
    return false;
  return parts.every(
    (part) =>
      part.length > 0 &&
      part.length <= MAX_SEGMENT &&
      part !== '.' &&
      part !== '..' &&
      !hasControl(part),
  );
}

/** Per-tenant totals and one entry per object, sorted for a deterministic archive. */
export function buildFileManifest({
  date,
  bucket,
  files,
  generatedAt = Date.now(),
}) {
  const sorted = [...files].sort((a, b) => a.key.localeCompare(b.key));
  const tenants = {};
  let bytes = 0;
  for (const file of sorted) {
    const tenant = file.key.split('/')[1];
    const entry = tenants[tenant] ?? { objects: 0, bytes: 0 };
    entry.objects += 1;
    entry.bytes += file.bytes;
    tenants[tenant] = entry;
    bytes += file.bytes;
  }
  return {
    format: 'bikri-files',
    version: 1,
    date,
    bucket,
    generated_at: generatedAt,
    objects: sorted.length,
    bytes,
    tenants,
    files: sorted.map((file) => ({
      key: file.key,
      bytes: file.bytes,
      sha256: file.sha256,
      etag: file.etag ?? null,
    })),
  };
}

/** Runs `fn` over `items` with at most `limit` in flight; rejects on the first failure. */
export async function mapPool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      for (;;) {
        const index = next;
        next += 1;
        if (index >= items.length) return;
        results[index] = await fn(items[index], index);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

function retryable(error) {
  if (error instanceof R2DownloadError)
    return error.status === 429 || error.status >= 500;
  // Network failures (DNS, reset, timeout) are worth retrying; other errors are bugs.
  return error instanceof TypeError;
}

export async function withRetry(fn, { attempts = 3, baseMs = 250 } = {}) {
  const total = Math.max(1, attempts);
  for (let attempt = 0; attempt < total; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      if (attempt === total - 1 || !retryable(error)) throw error;
      if (baseMs > 0)
        await new Promise((done) => setTimeout(done, baseMs * 2 ** attempt));
    }
  }
  throw new Error('retry loop finished without a result');
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') out.dryRun = true;
    else if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--'))
        throw new Error(`missing value for --${key}`);
      out[key] = value;
      i += 1;
    } else {
      throw new Error(`unknown argument ${arg}`);
    }
  }
  return out;
}

function intInRange(value, fallback, min, max) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max)
    throw new Error(`expected an integer between ${min} and ${max}`);
  return parsed;
}

function totals(date, bucket, objects, bytes, skipped) {
  return { date, bucket, objects, bytes, skipped };
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const date = args.date ?? backupDate();
  const bucket = args.bucket ?? DEFAULT_BUCKET;
  const prefix = args.prefix ?? DEFAULT_PREFIX;
  const outDir = resolve(
    args['out-dir'] ?? join(process.cwd(), 'bikri-files-backup'),
  );
  const concurrency = intInRange(args.concurrency, 8, 1, 32);
  const retryBaseMs = intInRange(args['retry-base-ms'], 250, 0, 60_000);
  const auth = r2Auth();

  const listed = await listObjects(bucket, prefix, auth);
  const objects = [];
  let skipped = 0;
  for (const object of listed) {
    const key = String(object.key ?? '');
    if (!key.startsWith(prefix)) {
      skipped += 1;
      continue;
    }
    if (!isFileKey(key))
      throw new Error('Unexpected object key in the files bucket');
    objects.push({ ...object, key });
  }
  const totalBytes = objects.reduce(
    (sum, object) => sum + Number(object.size ?? 0),
    0,
  );
  const tenants = new Set(objects.map((object) => object.key.split('/')[1]));
  if (args.dryRun) {
    console.log(
      JSON.stringify({
        ...totals(date, bucket, objects.length, totalBytes, skipped),
        tenants: tenants.size,
        dryRun: true,
      }),
    );
    return {
      objects: objects.length,
      bytes: totalBytes,
      tenants: tenants.size,
      skipped,
    };
  }

  await mkdir(join(outDir, 'files'), { recursive: true });
  const files = await mapPool(objects, concurrency, async (object) => {
    const bytes = await withRetry(
      () => downloadObject(bucket, object.key, auth),
      { baseMs: retryBaseMs },
    );
    const expected = Number(object.size);
    if (
      Number.isFinite(expected) &&
      expected >= 0 &&
      bytes.byteLength !== expected
    )
      throw new Error('R2 object size does not match the listing');
    const dest = join(outDir, 'files', ...object.key.split('/'));
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, bytes);
    return {
      key: object.key,
      bytes: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      etag: typeof object.etag === 'string' ? object.etag : null,
    };
  });

  const manifest = buildFileManifest({ date, bucket, files });
  await writeFile(
    join(outDir, `files-${date}.manifest.json`),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  console.log(
    JSON.stringify({
      ...totals(date, bucket, manifest.objects, manifest.bytes, skipped),
      tenants: Object.keys(manifest.tenants).length,
    }),
  );
  return manifest;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
