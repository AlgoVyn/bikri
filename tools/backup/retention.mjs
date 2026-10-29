#!/usr/bin/env node
/**
 * R2 retention for nightly backups (docs/09 §2 step 6): keep the last 30
 * daily exports and the 1st of each of the last 12 months, delete the rest.
 *
 * Usage:
 *   node tools/backup/retention.mjs [--bucket bikri-backups] [--prefix d1/]
 *     [--today YYYY-MM-DD] [--dry-run]
 */
import { fileURLToPath } from 'node:url';
import { cloudflareJson, listObjects, objectPath } from './cloudflare.mjs';
import { backupDate } from './export.mjs';

/** Keys are `d1/YYYY-MM-DD.sql.gz` and `d1/YYYY-MM-DD.manifest.json`. */
export function backupKeyDate(key, prefix = 'd1/') {
  if (!key.startsWith(prefix)) return null;
  const match = /^(\d{4}-\d{2}-\d{2})\.(?:sql\.gz|manifest\.json)$/u.exec(
    key.slice(prefix.length),
  );
  if (!match) return null;
  const date = match[1];
  const parsed = new Date(`${date}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== date
    ? null
    : date;
}

/** Which keys the retention policy deletes for a given object listing. */
export function retentionPlan(keys, today, prefix = 'd1/') {
  const dated = keys
    .map((key) => ({ key, date: backupKeyDate(key, prefix) }))
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

async function listKeys(bucket, prefix) {
  const objects = await listObjects(bucket, prefix);
  return objects.map((object) => String(object.key));
}

async function deleteKey(bucket, key) {
  await cloudflareJson(objectPath(bucket, key), { method: 'DELETE' });
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const bucket = args.bucket ?? 'bikri-backups';
  const prefix = args.prefix ?? 'd1/';
  const today = args.today ?? backupDate();
  const keys = await listKeys(bucket, prefix);
  const plan = retentionPlan(keys, today, prefix);
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
