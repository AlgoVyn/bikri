import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

// Real migrations from packages/db/migrations are applied before every test file (10 §1).
const migrations = await readD1Migrations('../../packages/db/migrations');

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        // Test-only values (10 §5): ENV=test enables ACCESS_TEST_EMAIL; never the production origin.
        bindings: {
          TEST_MIGRATIONS: migrations,
          ENV: 'test',
          ALLOWED_ORIGINS: 'https://bikri.test',
          ACCESS_TEST_EMAIL: 'adnan@yaqoob.org',
          ACCESS_AUD: 'test-aud',
          OWNER_EMAILS: 'adnan@yaqoob.org',
          OWNER_CODE_KEY: 'test-owner-code-key-0123456789abcdef',
          OWNER_SESSION_KEY: 'test-owner-session-key-0123456789abcdef',
        },
      },
    }),
  ],
  test: {
    include: ['test/**/*.test.ts'],
    setupFiles: ['./test/apply-migrations.ts'],
  },
});
