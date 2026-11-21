import type { BikriDb, PrintJob } from '@bikri/db';

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
    const jobs = await db.print_jobs
      .where('[status+created_at]')
      .between(['queued', 0], ['queued', Number.MAX_SAFE_INTEGER])
      .toArray();
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

const documentKey = (job: {
  sale_id?: string;
  refund_id?: string;
  day_close_id?: string;
  supplier_return_id?: string;
}): string | null =>
  job.sale_id
    ? `sale:${job.sale_id}`
    : job.refund_id
      ? `refund:${job.refund_id}`
      : job.day_close_id
        ? `day:${job.day_close_id}`
        : job.supplier_return_id
          ? `return:${job.supplier_return_id}`
          : null;

function unresolvedFailed(jobs: readonly PrintJob[]): PrintJob[] {
  const lastDone = new Map<string, number>();
  for (const job of jobs) {
    const key = documentKey(job);
    if (job.status !== 'done' || key === null) continue;
    lastDone.set(key, Math.max(lastDone.get(key) ?? 0, Number(job.created_at)));
  }
  return jobs.filter((job) => {
    if (job.status !== 'failed') return false;
    const key = documentKey(job);
    return key === null || Number(job.created_at) > (lastDone.get(key) ?? 0);
  });
}

/** The newest failed job whose document has not since printed successfully. */
export function latestUnresolvedFailed(
  jobs: readonly PrintJob[],
): PrintJob | undefined {
  return unresolvedFailed(jobs).sort(
    (a, b) => Number(b.created_at) - Number(a.created_at),
  )[0];
}

function documentIndex(job: PrintJob): { index: string; id: string } | null {
  if (job.sale_id) return { index: 'sale_id', id: job.sale_id };
  if (job.refund_id) return { index: 'refund_id', id: job.refund_id };
  if (job.day_close_id) return { index: 'day_close_id', id: job.day_close_id };
  if (job.supplier_return_id)
    return { index: 'supplier_return_id', id: job.supplier_return_id };
  return null;
}

/** Failed jobs that a later successful job for the same document has not superseded. */
export async function unresolvedFailedCount(db: BikriDb): Promise<number> {
  // Read only the failed jobs (usually zero), then probe the document's index for
  // a later `done`. Reading every `done` job in the 90-day table made every print
  // and every Home refresh scan thousands of rows (D-231).
  const failed = await db.print_jobs
    .where('[status+created_at]')
    .between(['failed', 0], ['failed', Number.MAX_SAFE_INTEGER])
    .toArray();
  // A broken printer can leave thousands of failed jobs (retention trims only
  // `done`). One index lookup per failed job would then be an N+1 on every Home
  // refresh; fall back to the single done scan for a backlog.
  if (failed.length > 50) {
    const done = await db.print_jobs
      .where('[status+created_at]')
      .between(['done', 0], ['done', Number.MAX_SAFE_INTEGER])
      .toArray();
    return unresolvedFailed([...failed, ...done]).length;
  }
  let count = 0;
  for (const job of failed) {
    const ref = documentIndex(job);
    if (ref === null) {
      count += 1;
      continue;
    }
    const later = await db.print_jobs
      .where(ref.index)
      .equals(ref.id)
      .filter(
        (candidate) =>
          candidate.status === 'done' &&
          Number(candidate.created_at) > Number(job.created_at),
      )
      .first();
    if (!later) count += 1;
  }
  return count;
}
