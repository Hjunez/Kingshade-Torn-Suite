import { defineConfig } from '@playwright/test';

export default defineConfig({
  forbidOnly: Boolean(process.env.CI),
  fullyParallel: false,
  outputDir: 'test-results/playwright',
  reporter: process.env.CI ? 'line' : 'list',
  retries: process.env.CI ? 1 : 0,
  testDir: './tests/browser',
  timeout: 10_000,
  use: {
    browserName: 'chromium',
    headless: true,
    locale: 'en-US',
    timezoneId: 'UTC',
    trace: 'retain-on-failure',
    viewport: { height: 720, width: 1280 },
  },
  workers: 1,
});
