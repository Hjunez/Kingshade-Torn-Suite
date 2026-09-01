import { defineConfig } from '@playwright/test';

export default defineConfig({
  forbidOnly: Boolean(process.env.CI),
  fullyParallel: false,
  outputDir: 'test-results/playwright-desktop',
  projects: [
    {
      name: 'bundled-chromium',
      use: { browserName: 'chromium', channel: 'chromium' },
    },
    {
      name: 'google-chrome',
      use: { browserName: 'chromium', channel: 'chrome' },
    },
  ],
  reporter: process.env.CI ? 'line' : 'list',
  retries: 0,
  testDir: './tests/browser',
  testMatch: ['war-dibs-desktop-ui.spec.js', 'war-dibs-compatibility.spec.js'],
  timeout: 30_000,
  use: {
    headless: true,
    locale: 'en-US',
    timezoneId: 'UTC',
    trace: 'retain-on-failure',
    viewport: { height: 720, width: 1280 },
  },
  workers: 1,
});
