import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'scripts/**/*.test.ts'],
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    coverage: {
      provider: 'v8',
      // 10-testing: 90% for the till's data and sync layers.
      include: ['src/data/**/*.ts', 'src/sync/**/*.ts'],
      exclude: ['**/*.test.ts', 'src/data/testDb.ts', 'src/data/testShop.ts'],
      thresholds: { lines: 90, statements: 90, functions: 90, branches: 85 },
    },
  },
});
