import type { BikriDb } from '@bikri/db';

/** Puts a failed job back in the queue (T-020); kept separate from the receipt code. */
export async function retryPrintJob(db: BikriDb, id: string): Promise<void> {
  await db.print_jobs.update(id, { status: 'queued', error: undefined });
}
