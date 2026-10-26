import type { D1Migration } from 'cloudflare:test';

declare global {
  namespace Cloudflare {
    interface Env {
      /** Set only in Vitest (vitest.config.ts): the parsed D1 migrations. */
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}
