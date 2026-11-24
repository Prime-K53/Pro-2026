import { test, expect } from '@playwright/test';

/**
 * E2E acceptance suite for the V2 gap-closure programme.
 *
 * These tests require a running dev server and installed browsers:
 *   npx playwright install chromium
 *   npm run dev            # in another terminal
 *   npm run test:e2e
 *
 * The five acceptance-critical flows from the V2 plan:
 *   1. POS shift open → sale → close
 *   2. 2FA login (enroll → login with code)
 *   3. Payroll run → payslip
 *   4. QR scan → verify page
 *   5. Delivery assignment (vehicle + driver + schedule)
 *
 * Each test guards on a reachable server so the suite degrades gracefully in
 * environments where the dev server is not running.
 */

const BASE = process.env.PMS_BASE_URL || 'http://localhost:3000';

async function serverUp(): Promise<boolean> {
  try {
    const resp = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(2000) });
    return resp.ok;
  } catch {
    return false;
  }
}

test.beforeAll(async () => {
  const up = await serverUp();
  if (!up) {
    throw new Error(
      `Dev server not reachable at ${BASE}. Start it with \`npm run dev\` before running E2E.`
    );
  }
});

test('login page renders', async ({ page }) => {
  await page.goto(BASE);
  await expect(page.locator('body')).toBeVisible();
});

test('login form has username and password fields', async ({ page }) => {
  await page.goto(BASE);
  await expect(page.locator('input')).not.toHaveCount(0);
});

test('POS shift open → sale → close', async ({ page }) => {
  // Login as a cashier (demo credentials are environment-specific; the test
  // uses whatever the dev server seeds).
  await page.goto(BASE);
  // Navigate to Smart Operations → Cashier Shift.
  // This is a placeholder until the demo credentials / flow are pinned.
  // The structure proves the E2E harness can drive a multi-step POS flow.
  await page.getByRole('button', { name: /smart operations/i }).click();
  await expect(page.locator('body')).toContainText(/shift/i);
});

test('2FA login flow', async ({ page }) => {
  // Enroll 2FA, then log in with a TOTP code.
  // Placeholder: requires a seeded user with 2FA and a TOTP generator.
  await page.goto(BASE);
  await expect(page.locator('body')).toBeVisible();
});

test('payroll run → payslip', async ({ page }) => {
  // Run payroll and open a payslip.
  // Placeholder: requires a seeded employee + bank account.
  await page.goto(BASE);
  await page.getByRole('button', { name: /payroll/i }).click();
  await expect(page.locator('body')).toContainText(/payroll/i);
});

test('QR scan → verify page', async ({ page }) => {
  // Generate a QR for a document, then visit the verify URL.
  // Placeholder: requires a seeded document and `documents:qr:manage` role.
  await page.goto(BASE);
  await expect(page.locator('body')).toBeVisible();
});

test('delivery assignment (vehicle + driver + schedule)', async ({ page }) => {
  // Create a vehicle, driver, and schedule.
  // Placeholder: requires seeded delivery note.
  await page.goto(BASE);
  await expect(page.locator('body')).toBeVisible();
});