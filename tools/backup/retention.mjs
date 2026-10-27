#!/usr/bin/env node
/**
 * R2 retention for nightly backups (docs/09 §2 step 6): keep the last 30
 * daily exports and the 1st of each of the last 12 months, delete the rest.
 *
 * Usage:
 *   node tools/backup/retention.mjs [--bucket bikri-backups] [--prefix d1/]
 *     [--today YYYY-MM-DD] [--dry-run]
 */
const API = 'https://api.cloudflare.com/client/v4';

import { fileURLToPath } from 'node:url';

/** Keys are `d1/YYYY-MM-DD.sql.gz` and `d1/YYYY-MM-DD.manifest.json`. */
export function backupKeyDate(key) {
  const match = /^d1\/(\d{4}-\d{2}-\d{2})\.(?:sql\.gz|manifest\.json)$/u.exec(
    key,
  );
  if (!match) return null;
  const date = match[1];
  return Number.isNaN(Date.parse(`${date}T00:00:00Z`)) ? null : date;
}

/** Which keys the retention policy deletes for a given object listing. */
export function retentionPlan(keys, today) {
  const dated = keys
    .map((key) => ({ key, date: backupKeyDate(key) }))
    .filter((row) => row.date !== null);
  const dates = [...new Set(dated.map((row) => row.date))].sort().reverse();
  const daily = new Set(dates.slice(0, 30));
  const monthly = new Set(
    dates.filter((date) => date.endsWith('-01')).slice(0, 12),
  );
  const keep = new Set([...daily, ...monthly]);
  // Unknown keys are left alone: only our own dated objects are ours to delete.
  const remove = dated
    .filter((row) => !keep.has(row.date) && row.date < today)
    .map((row) => row.key);
  return { keep: [...keep].sort(), remove };
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

async function cloudflare(path, init = {}) {
  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!account || !token)
    throw new Error(
      'CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are required',
    );
  const res = await fetch(`${API}/accounts/${account}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      ...(init.headers ?? {}),
    },
  });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body?.success) {
    const message = body?.errors?.[0]?.message ?? res.statusText;
    throw new Error(`Cloudflare API ${res.status}: ${message}`);
  }
  return body;
}

async function listKeys(bucket, prefix) {
  const keys = [];
  let cursor = '';
  for (let guard = 0; guard < 1000; guard += 1) {
    const query = new URLSearchParams({ prefix, per_page: '1000' });
    if (cursor) query.set('cursor', cursor);
    const page = await cloudflare(
      `/r2/buckets/${encodeURIComponent(bucket)}/objects?${query.toString()}`,
    );
    for (const object of page.result ?? []) keys.push(String(object.key));
    const cursorNext = page.result_info?.cursor;
    if (!page.result_info?.is_truncated || !cursorNext) break;
    cursor = cursorNext;
  }
  return keys;
}

async function deleteKey(bucket, key) {
  await cloudflare(
    `/r2/buckets/${encodeURIComponent(bucket)}/objects/${encodeURIComponent(key)}`,
    { method: 'DELETE' },
  );
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const bucket = args.bucket ?? 'bikri-backups';
  const prefix = args.prefix ?? 'd1/';
  const today = args.today ?? new Date().toISOString().slice(0, 10);
  const keys = await listKeys(bucket, prefix);
  const plan = retentionPlan(keys, today);
  if (args.dryRun) {
    console.log(JSON.stringify({ today, ...plan, dryRun: true }));
    return plan;
  }
  for (const key of plan.remove) await deleteKey(bucket, key);
  console.log(
    JSON.stringify({
      today,
      removed: plan.remove.length,
      keep: plan.keep.length,
    }),
  );
  return plan;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
