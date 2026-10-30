import type { PrintJob } from '@bikri/db';
import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useToast } from '../components/Toast.tsx';
import { getDb } from '../data/db.ts';
import {
  recoverInterruptedPrintJobs,
  retryPrintJob,
} from '../data/printJobs.ts';

/**
 * Runs the print queue while the till is open (06 §9). A failed job raises a toast with
 * Retry and Print later; the sale screens stay usable.
 */
export function usePrintService(): void {
  const { t } = useTranslation();
  const toast = useToast();
  const ref = useRef({ t, toast });
  ref.current = { t, toast };
  useEffect(() => {
    void recoverInterruptedPrintJobs(getDb());
  }, []);
  const trigger = useLiveQuery(async () => {
    const db = getDb();
    const queued = await db.print_jobs.where('status').equals('queued').count();
    const printer = (await db.kv.get('printer'))?.value;
    return queued > 0 && printer
      ? `${queued}:${JSON.stringify(printer)}`
      : null;
  }, []);
  useEffect(() => {
    if (!trigger) return;
    const db = getDb();
    const onResult = (job: PrintJob) => {
      if (job.status !== 'failed') return;
      const { t: tr, toast: tt } = ref.current;
      tt.push(
        tr('print.failed_toast', {
          reason: tr(`print.err_${job.error ?? 'FAILED'}`),
        }),
        'error',
        [
          {
            label: tr('done.retry'),
            onClick: () => void retryPrintJob(db, job.id),
          },
          { label: tr('print.later'), onClick: () => undefined },
        ],
      );
    };
    // A job queued just as a run was finishing joins that run's promise; check again after it.
    const kick = async (left: number) => {
      // Loaded on the first job so the encoder stays out of the initial bundle.
      const [{ processQueue }, { browserPrintDeps }] = await Promise.all([
        import('./printService.ts'),
        import('./printDeps.ts'),
      ]);
      await processQueue(db, browserPrintDeps(), onResult);
      const more = await db.print_jobs.where('status').equals('queued').count();
      if (more > 0 && left > 0) await kick(left - 1);
    };
    void kick(3);
  }, [trigger]);
}
