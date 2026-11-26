import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

/**
 * Frontend unit/component test config.
 *
 * This is intentionally separate from:
 * - `playwright.config.ts` (E2E), and
 * - `scripts/run-tests.mjs` (backend `node:test`).
 *
 * Run with `pnpm test:unit` (or `pnpm vitest`). Backend tests stay on
 * `pnpm test`.
 */
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    css: false,
    restoreMocks: true,
  },
});