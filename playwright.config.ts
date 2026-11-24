import { defineConfig } from '@playwright/test';

/**
 * Playwright E2E configuration.
 *
 * Requires: npm i -D @playwright/test @axe-core/playwright && npx playwright install chromium
 * Run:      npm run test:e2e
 */
export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  fullyParallel: true,
  reporter: [['list']],
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:5173',
    headless: true,
    trace: 'on-first-retry',
  },
});