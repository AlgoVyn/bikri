/**
 * Local-only history retention (D-226).
 *
 * Business records (sales, stock movements, ledger entries, print history for a document
 * still inside the window) stay for the life of the shop. Only operational logs that no
 * screen or report needs forever are trimmed: completed print jobs, failed photo/logo
 * uploads and quarantined pull rows. Server-side backups and the tenant export remain the
 * long-term record.
 */
import type { BikriDb } from '@bikri/db';

const DAY = 86_400_000;

/** A completed print job older than this can no longer be reprinted from the till. */
export const PRINT_JOB_RETENTION_MS = 90 * DAY;
/** A failed upload keeps its blob so the user can retry during this window. */
export const FAILED_UPLOAD_RETENTION_MS = 30 * DAY;
/** Quarantined pull rows are diagnostics, not data. */
export const PULL_ERROR_RETENTION_MS = 30 * DAY;

export type RetentionResult = {
  printJobs: number;
  failedUploads: number;
  pullErrors: number;
};

/**
 * Trims the local-only logs. Safe to call often: the caller gates it to once a day, and
 * every delete is by an explicit cutoff, never `clear()`.
 */
export async function pruneLocalHistory(
  db: BikriDb,
  now = Date.now(),
): Promise<RetentionResult> {
  return db.transaction(
    'rw',
    [db.print_jobs, db.file_queue, db.kv],
    async () => {
      const oldJobs = await db.print_jobs
        .where('[status+created_at]')
        .between(
          ['done', 0],
          ['done', now - PRINT_JOB_RETENTION_MS],
          true,
          false,
        )
        .primaryKeys();
      if (oldJobs.length > 0) await db.print_jobs.bulkDelete(oldJobs);

      // primaryKeys() never reads the failed blob itself.
      const oldUploads = await db.file_queue
        .where('[status+created_at]')
        .between(
          ['failed', 0],
          ['failed', now - FAILED_UPLOAD_RETENTION_MS],
          true,
          false,
        )
        .primaryKeys();
      if (oldUploads.length > 0) await db.file_queue.bulkDelete(oldUploads);

      let removedErrors = 0;
      const stored = (await db.kv.get('pull_errors')) as
        | {
            value?: Array<{ at?: number } & Record<string, unknown>>;
          }
        | undefined;
      if (Array.isArray(stored?.value) && stored.value.length > 0) {
        const kept = stored.value.filter(
          (entry) =>
            typeof entry.at !== 'number' ||
            entry.at >= now - PULL_ERROR_RETENTION_MS,
        );
        removedErrors = stored.value.length - kept.length;
        if (removedErrors > 0)
          await db.kv.put({ key: 'pull_errors', value: kept });
      }

      return {
        printJobs: oldJobs.length,
        failedUploads: oldUploads.length,
        pullErrors: removedErrors,
      };
    },
  );
}

/** Runs at most once per UTC-ish day, from the shell idle callback. */
export async function pruneLocalHistoryIfDue(
  db: BikriDb,
  now = Date.now(),
): Promise<RetentionResult | null> {
  const last = (await db.kv.get('local_prune_at'))?.value;
  if (typeof last === 'number' && now - last < DAY) return null;
  const result = await pruneLocalHistory(db, now);
  await db.kv.put({ key: 'local_prune_at', value: now });
  return result;
}
