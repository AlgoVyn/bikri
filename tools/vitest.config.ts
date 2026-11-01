import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'src/**/*.test.ts',
      '*.test.mjs',
      '*.test.ts',
      'backup/*.test.mjs',
      'perf/*.test.mjs',
    ],
  },
});
