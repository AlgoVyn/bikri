import { resetDevDb, seedReadyShop } from './seed.ts';

declare global {
  interface Window {
    __bikriTest?: {
      seedReadyShop: () => Promise<void>;
      reset: () => Promise<void>;
    };
  }
}

/** E2E-only hooks (dev and `--mode e2e` builds; never in production, D-088). */
export function installTestHooks(): void {
  window.__bikriTest = { seedReadyShop, reset: resetDevDb };
}
