import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'src/**/*.test.ts',
      '*.test.mjs',
      'backup/*.test.mjs',
      'perf/*.test.mjs',
    ],
  },
});
