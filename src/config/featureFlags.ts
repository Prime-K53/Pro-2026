/**
 * Build-time feature flags.
 *
 * These flags are compiled into the bundle, so they must never be used to
 * protect anything secret — they only control whether convenience UI is shown.
 */

function readFlag(name: string): string {
  try {
    const value = (import.meta.env as Record<string, unknown>)[name];
    return typeof value === 'string' ? value.trim().toLowerCase() : '';
  } catch {
    return '';
  }
}

const explicitDemo = readFlag('VITE_DEMO_MODE');
const isDev = Boolean(import.meta.env?.DEV);

/**
 * Demo mode exposes seeded evaluation helpers (quick-fill sign-in buttons,
 * "reload demo data" actions).
 *
 * - Development builds: ON by default.
 * - Production builds: OFF unless `VITE_DEMO_MODE=true` is set at build time.
 */
export const DEMO_MODE: boolean =
  explicitDemo === 'true' || explicitDemo === '1' || explicitDemo === 'yes'
    ? true
    : explicitDemo === 'false' || explicitDemo === '0' || explicitDemo === 'no'
    ? false
    : isDev;
export const ADVANCED_ACTIONS_FRAMEWORK: boolean =
  String((import.meta as any).env?.VITE_ADVANCED_ACTIONS || '').trim().toLowerCase() === 'true';

export function isAdvancedActionsEnabled(flags?: Record<string, boolean> | null): boolean {
  if (flags && typeof flags.advancedActions === 'boolean') return flags.advancedActions;
  return ADVANCED_ACTIONS_FRAMEWORK;
}
