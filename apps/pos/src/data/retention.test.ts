import { afterEach, describe, expect, it } from 'vitest';
import { pruneLocalHistory, pruneLocalHistoryIfDue } from './retention.ts';
import { dropTestDbs } from './testDb.ts';
import { readyDb } from './testShop.ts';

afterEach(dropTestDbs);

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 15, 9, 0, 0);

const job = (id: string, status: 'done' | 'failed', created_at: number) => ({
  id,
  kind: 'sale' as const,
  status,
  created_at,
});

const upload = (
  id: number,
  status: 'failed' | 'pending',
  created_at?: number,
) => ({
  id,
  kind: 'product_image' as const,
  target_id: `p-${id}`,
  blob: new Blob(['x']),
  sha256: `sha-${id}`,
  status,
  ...(created_at === undefined ? {} : { created_at }),
});

describe('local history retention', () => {
  it('trims old completed and failed jobs, old failed uploads and old pull errors', async () => {
    const db = await readyDb('retention');
    await db.print_jobs.bulkAdd([
      job('done-old', 'done', NOW - 100 * DAY),
      job('done-new', 'done', NOW - 10 * DAY),
      job('failed-old', 'failed', NOW - 100 * DAY),
      job('failed-new', 'failed', NOW - 10 * DAY),
    ]);
    await db.file_queue.bulkAdd([
      upload(1, 'failed', NOW - 40 * DAY),
      upload(2, 'failed', NOW - 5 * DAY),
      // Entries queued before the timestamp existed must not be deleted blind.
      upload(3, 'failed'),
      upload(4, 'pending', NOW - 40 * DAY),
    ]);
    await db.kv.put({
      key: 'pull_errors',
      value: [
        { tbl: 'sales', id: 'old', at: NOW - 40 * DAY },
        { tbl: 'sales', id: 'new', at: NOW - 5 * DAY },
      ],
    });
    await db.sync_conflicts.bulkAdd([
      {
        id: 'conflict-old',
        tbl: 'refunds',
        row_id: 'r1',
        resolution: 'acknowledged',
        fields_json: '{}',
        at: NOW - 100 * DAY,
      },
      {
        id: 'conflict-new',
        tbl: 'refunds',
        row_id: 'r2',
        resolution: 'merged',
        fields_json: '{}',
        at: NOW - 5 * DAY,
      },
      {
        id: 'conflict-open',
        tbl: 'refunds',
        row_id: 'r3',
        resolution: 'needs_owner',
        fields_json: '{}',
        at: NOW - 100 * DAY,
      },
    ]);

    expect(await pruneLocalHistory(db, NOW)).toEqual({
      printJobs: 2,
      failedUploads: 1,
      pullErrors: 1,
      resolvedConflicts: 1,
    });
    expect(await db.print_jobs.get('done-old')).toBeUndefined();
    expect(await db.print_jobs.get('done-new')).toBeDefined();
    expect(await db.print_jobs.get('failed-old')).toBeUndefined();
    expect(await db.print_jobs.get('failed-new')).toBeDefined();
    expect(await db.file_queue.get(1)).toBeUndefined();
    expect(await db.file_queue.get(2)).toBeDefined();
    expect(await db.file_queue.get(3)).toBeDefined();
    expect(await db.file_queue.get(4)).toBeDefined();
    expect((await db.kv.get('pull_errors'))?.value).toEqual([
      { tbl: 'sales', id: 'new', at: NOW - 5 * DAY },
    ]);
    expect(await db.sync_conflicts.get('conflict-old')).toBeUndefined();
    expect(await db.sync_conflicts.get('conflict-new')).toBeDefined();
    expect(await db.sync_conflicts.get('conflict-open')).toBeDefined();
  });

  it('runs at most once a day', async () => {
    const db = await readyDb('retention-gate');
    await db.print_jobs.add(job('done-old', 'done', NOW - 100 * DAY));
    expect(await pruneLocalHistoryIfDue(db, NOW)).toMatchObject({
      printJobs: 1,
    });
    await db.print_jobs.add(job('done-old-2', 'done', NOW - 100 * DAY));
    expect(await pruneLocalHistoryIfDue(db, NOW + 60_000)).toBeNull();
    expect(await db.print_jobs.get('done-old-2')).toBeDefined();
    expect(await pruneLocalHistoryIfDue(db, NOW + 2 * DAY)).toMatchObject({
      printJobs: 1,
    });
  });
});
