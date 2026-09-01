import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    clearMocks: true,
    environmentOptions: {
      jsdom: {
        url: 'https://www.torn.com/page.php?sid=crimes',
      },
    },
    fileParallelism: false,
    include: ['tests/unit/**/*.test.js', 'tests/dom/**/*.test.js', 'tests/race/**/*.test.js'],
    restoreMocks: true,
    sequence: {
      concurrent: false,
    },
    testTimeout: 5_000,
    unstubGlobals: true,
  },
});
