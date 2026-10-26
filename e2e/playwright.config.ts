import { defineConfig, devices } from '@playwright/test';

// E2E runs against `wrangler dev` serving the built PWA + local D1 (docs/10-testing.md §1).
const PORT = 8787;

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
    command: `pnpm --filter @bikri/pos build && pnpm --filter @bikri/api exec wrangler d1 migrations apply bikri --local && pnpm --filter @bikri/api exec wrangler dev --port ${PORT}`,
    url: `http://localhost:${PORT}/bikri/api/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    cwd: '..',
  },
});
