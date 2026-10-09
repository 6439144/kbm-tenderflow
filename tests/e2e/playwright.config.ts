import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright E2E Configuration for TenderFlow (Tasks T13 & T18)
 * Configures browsers, review demo endpoints, and test timeouts.
 */
export default defineConfig({
  testDir: './',
  timeout: 30000,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: process.env.CI ? [['github'], ['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: process.env.REVIEW_VM_URL || 'https://localhost',
    trace: 'on-first-retry',
    ignoreHTTPSErrors: true,
    screenshot: 'only-on-failure',
    video: 'retain-on-failure'
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] }
    }
  ]
});
