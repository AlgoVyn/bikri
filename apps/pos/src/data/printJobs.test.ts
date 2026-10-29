import { afterEach, describe, expect, it } from 'vitest';
import { cancelPrintJob, cancelQueuedPrintJobs } from './printJobs.ts';
import { dropTestDbs } from './testDb.ts';
import { readyDb } from './testShop.ts';

afterEach(dropTestDbs);

async function setup() {
  const db = await readyDb('print-jobs');
  await db.print_jobs.bulkAdd([
    { id: 'q1', kind: 'sale', status: 'queued', created_at: 1 },
    { id: 'q2', kind: 'sale', status: 'queued', created_at: 2 },
    { id: 'p1', kind: 'sale', status: 'printing', created_at: 3 },
    { id: 'd1', kind: 'sale', status: 'done', created_at: 4 },
    {
      id: 'f1',
      kind: 'sale',
      status: 'failed',
      error: 'NO_PRINTER',
      created_at: 5,
    },
  ]);
  return db;
}

describe('waiting print jobs', () => {
  it('cancels one queued job and leaves printing/done/failed jobs alone', async () => {
    const db = await setup();
    await cancelPrintJob(db, 'q1');
    expect(await db.print_jobs.get('q1')).toBeUndefined();
    expect((await db.print_jobs.get('q2'))?.status).toBe('queued');
    expect((await db.print_jobs.get('p1'))?.status).toBe('printing');
    expect((await db.print_jobs.get('d1'))?.status).toBe('done');
    expect((await db.print_jobs.get('f1'))?.status).toBe('failed');
  });

  it('cancels every waiting job and reports the count', async () => {
    const db = await setup();
    expect(await cancelQueuedPrintJobs(db)).toBe(2);
    expect(await db.print_jobs.where('status').equals('queued').count()).toBe(
      0,
    );
    expect(await db.print_jobs.count()).toBe(3);
  });

  it('does not delete a job that started printing before the cancel', async () => {
    const db = await setup();
    await db.print_jobs.update('q1', { status: 'printing' });
    await cancelPrintJob(db, 'q1');
    expect((await db.print_jobs.get('q1'))?.status).toBe('printing');
  });
});
