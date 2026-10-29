import type { BikriDb } from '@bikri/db';

/** Puts a failed job back in the queue (T-020); kept separate from the receipt code. */
export async function retryPrintJob(db: BikriDb, id: string): Promise<void> {
  await db.print_jobs.update(id, { status: 'queued', error: undefined });
}

/** Drops one waiting job. Jobs already printing cannot be cancelled. */
export async function cancelPrintJob(db: BikriDb, id: string): Promise<void> {
  await db.transaction('rw', db.print_jobs, async () => {
    const job = await db.print_jobs.get(id);
    if (job?.status !== 'queued') return;
    await db.print_jobs.delete(id);
  });
}

/** Drops every waiting job; returns how many were removed. */
export async function cancelQueuedPrintJobs(db: BikriDb): Promise<number> {
  return db.transaction('rw', db.print_jobs, async () => {
    const jobs = await db.print_jobs.where('status').equals('queued').toArray();
    if (jobs.length === 0) return 0;
    await db.print_jobs.bulkDelete(jobs.map((job) => job.id));
    return jobs.length;
  });
}

/** Moves jobs left in 'printing' by a closed/crashed tab to failed so they can be retried. */
export async function recoverInterruptedPrintJobs(
  db: BikriDb,
  now = Date.now(),
  staleMs = 2 * 60_000,
): Promise<number> {
  return db.transaction('rw', db.print_jobs, async () => {
    const jobs = await db.print_jobs
      .where('status')
      .equals('printing')
      .toArray();
    const stale = jobs.filter(
      (job) => now - (job.started_at ?? job.created_at) > staleMs,
    );
    await Promise.all(
      stale.map((job) =>
        db.print_jobs.update(job.id, {
          status: 'failed',
          error: 'INTERRUPTED',
        }),
      ),
    );
    return stale.length;
  });
}
