import { renderReceiptText } from '@bikri/printer';
import { router } from '../app.tsx';
import { getDb } from '../data/db.ts';
import { setKv } from '../data/kv.ts';
import { jobReceipt } from '../print/receiptFiles.ts';
import { beepCount } from '../sell/beep.ts';
import {
  finishSetupHere,
  resetDevDb,
  seedCustomer,
  seedManyProducts,
  seedProducts,
  seedReadyShop,
  seedTodaySales,
  unlockAs,
} from './seed.ts';

declare global {
  interface Window {
    __bikriTest?: {
      seedReadyShop: () => Promise<void>;
      finishSetupHere: () => Promise<void>;
      /** Push + pull now (T-030 engine). */
      syncNow: () => Promise<void>;
      reset: () => Promise<void>;
      unlockAs: typeof unlockAs;
      seedTodaySales: () => Promise<void>;
      setKv: (key: string, value: unknown) => Promise<void>;
      /** Client-side navigation (keeps the in-memory session, unlike page.goto). */
      navigate: (to: string) => Promise<void>;
      seedProducts: typeof seedProducts;
      seedManyProducts: typeof seedManyProducts;
      beeps: () => number;
      seedCustomer: typeof seedCustomer;
      /** Text the print service would print for a print job (null when it has no sale). */
      printJobText: (id: string) => Promise<string | null>;
    };
  }
}

/** E2E-only hooks (dev and `--mode e2e` builds; never in production, D-088). */
export function installTestHooks(): void {
  window.__bikriTest = {
    seedReadyShop,
    finishSetupHere: () => finishSetupHere(),
    syncNow: async () => (await import('../sync/engine.ts')).syncNow(),
    reset: resetDevDb,
    unlockAs,
    seedTodaySales,
    setKv: (key, value) => setKv(getDb(), key, value),
    navigate: (to) => router.navigate({ to }),
    seedProducts,
    seedManyProducts,
    beeps: beepCount,
    seedCustomer,
    printJobText: async (id) => {
      const job = await getDb().print_jobs.get(id);
      const r = job ? await jobReceipt(getDb(), job) : null;
      return r
        ? renderReceiptText(r.blocks, {
            charsPerLine: r.paper.charsPerLine,
            itemLayout: r.paper.itemLayout,
          })
        : null;
    },
  };
}
