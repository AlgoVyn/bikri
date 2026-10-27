import { router } from '../app.tsx';
import { getDb } from '../data/db.ts';
import { setKv } from '../data/kv.ts';
import { beepCount } from '../sell/beep.ts';
import {
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
    };
  }
}

/** E2E-only hooks (dev and `--mode e2e` builds; never in production, D-088). */
export function installTestHooks(): void {
  window.__bikriTest = {
    seedReadyShop,
    reset: resetDevDb,
    unlockAs,
    seedTodaySales,
    setKv: (key, value) => setKv(getDb(), key, value),
    navigate: (to) => router.navigate({ to }),
    seedProducts,
    seedManyProducts,
    beeps: beepCount,
    seedCustomer,
  };
}
