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
          ACCESS_TEST_EMAIL: 'operator@example.com',
          ACCESS_AUD: 'test-aud',
          OWNER_EMAILS: 'operator@example.com',
          OWNER_CODE_KEY: 'test-owner-code-key-0123456789abcdef',
          OWNER_SESSION_KEY: 'test-owner-session-key-0123456789abcdef',
        },
      },
    }),
  ],
  test: {
    include: ['test/**/*.test.ts'],
    setupFiles: ['./test/apply-migrations.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary'],
      include: ['src/**/*.ts'],
      // Entrypoints are exercised through SELF but have no callable units of their own;
      // the cron adapter is the two-line `scheduled` export tested in coverage-gaps.
      exclude: [
        'src/**/*.test.ts',
        'src/index.ts',
        'src/cron/**',
        'src/secrets.d.ts',
      ],
      // 10-testing: 90% line/function coverage for the Worker integration suite.
      // Statements/branches sit lower because V8 counts every defensive auth, quota and
      // error branch; the floors still stop regressions in those paths.
      thresholds: { lines: 90, statements: 87, functions: 90, branches: 75 },
    },
  },
});
