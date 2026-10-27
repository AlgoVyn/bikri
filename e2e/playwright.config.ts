import { defineConfig, devices } from '@playwright/test';

// E2E runs against `wrangler dev` serving the built PWA + local D1 (docs/10-testing.md §1).
const PORT = 8787;
// Test-only Worker vars (10 §5): the Access bypass and fake email outbox need ENV=test, which the
// Worker refuses next to the production origin.
const TEST_VARS = [
  'ENV:test',
  `ALLOWED_ORIGINS:http://localhost:${PORT}`,
  'ACCESS_TEST_EMAIL:adnan@yaqoob.org',
  'OWNER_EMAILS:adnan@yaqoob.org',
  'OWNER_CODE_KEY:e2e-owner-code-key',
  'OWNER_SESSION_KEY:e2e-owner-session-key',
]
  .map((v) => `--var ${v}`)
  .join(' ');

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'desktop',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1280, height: 800 },
      },
    },
    {
      name: 'phone',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 390, height: 844 },
        hasTouch: true,
      },
    },
  ],
  webServer: {
    command: `pnpm --filter @bikri/pos build:e2e && pnpm --filter @bikri/api exec wrangler d1 migrations apply bikri --local && pnpm --filter @bikri/api exec wrangler dev --port ${PORT} ${TEST_VARS}`,
    url: `http://localhost:${PORT}/bikri/api/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    cwd: '..',
  },
});
