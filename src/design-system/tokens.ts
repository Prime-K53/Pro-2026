/**
 * Prime Printing ERP — Unified Design System Tokens (Standards 01–10)
 * -----------------------------------------------------------------------------
 * Single source of truth governing typography, color, spacing, elevation,
 * iconography, responsive breakpoints, accessibility minimums, and UI states.
 */

export const DESIGN_TOKENS = {
  version: '2026.1',
  name: 'Prime Printing ERP Design System',

  typography: {
    fontFamily: {
      sans: "'Plus Jakarta Sans', system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
      display: "'DM Serif Display', Georgia, serif",
      mono: "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
    },
    scale: {
      display: { fontSize: 'clamp(1.75rem, 2.5vw, 2.25rem)', lineHeight: 1.15, fontWeight: 400 },
      pageTitle: { fontSize: '1.375rem', lineHeight: 1.25, fontWeight: 700, tracking: '-0.02em' },
      modalTitle: { fontSize: '1.125rem', lineHeight: 1.35, fontWeight: 600, tracking: '-0.015em' },
      sectionTitle: { fontSize: '0.9375rem', lineHeight: 1.4, fontWeight: 700, tracking: '-0.01em' },
      body: { fontSize: '0.8125rem', lineHeight: 1.5, fontWeight: 400 },
      caption: { fontSize: '0.75rem', lineHeight: 1.45, fontWeight: 500 },
      label: { fontSize: '0.6875rem', lineHeight: 1.3, fontWeight: 600, tracking: '0.03em' },
      tableHeader: { fontSize: '0.6875rem', lineHeight: 1.3, fontWeight: 700, tracking: '0.04em' },
    },
    numericVariant: 'tabular-nums',
  },

  color: {
    brand: {
      50: '#ebf5ff',
      100: '#d6e9ff',
      200: '#a9d5ff',
      300: '#7ab8ff',
      400: '#3d9dff',
      500: '#0086ff',
      /** WCAG AA (>=4.9:1 with white text) primary interactive fill */
      600: '#0068c9',
      700: '#0055a6',
      800: '#004282',
      900: '#003263',
      950: '#002145',
    },
    semantic: {
      neutral: { lightText: '#475569', lightBg: '#f1f5f9', darkText: '#cbd5e1' },
      info: { lightText: '#0055a6', lightBg: '#ebf5ff', darkText: '#7ab8ff' },
      success: { lightText: '#15803d', lightBg: '#ecfdf5', darkText: '#6ee7b7' },
      warning: { lightText: '#b45309', lightBg: '#fffbeb', darkText: '#fcd34d' },
      danger: { lightText: '#be123c', lightBg: '#fff1f2', darkText: '#fda4af' },
      purple: { lightText: '#6d28d9', lightBg: '#f5f3ff', darkText: '#c4b5fd' },
    },
    themes: ['slate', 'classic', 'midnight'] as const,
  },

  spacing: {
    baseUnitPx: 4,
    pagePadding: 'p-4 sm:p-6',
    pageMaxWidth: 'max-w-7xl mx-auto',
    sectionGap: 'space-y-6',
    cardPadding: 'p-4 sm:p-5',
    gridGap: 'gap-4',
    tableCell: {
      comfortable: 'px-3 py-2.5',
      compact: 'px-2.5 py-1.5',
    },
  },

  radius: {
    control: '0.5rem', // 8px (buttons, inputs, compact surfaces)
    surface: '0.5rem', // 8px (single-elevation panels & cards)
    modal: '1rem', // 16px (dialogs & drawers)
    badge: '0.375rem', // 6px (status indicators — crisp, never pill-bloated)
  },

  iconography: {
    family: 'lucide-react',
    strokeWidth: 1.75,
    sizes: {
      xs: 14,
      sm: 16,
      md: 18,
      lg: 20,
      xl: 24,
    },
  },

  breakpoints: {
    sm: 640,
    md: 768,
    lg: 1024,
    xl: 1280,
    '2xl': 1440,
  },

  accessibility: {
    minTouchTargetTouchPx: 44,
    minControlHeightDesktopPx: 36,
    minContrastRatioText: 4.5,
    minContrastRatioLarge: 3.0,
    focusRing: '2px solid #0086ff',
    focusOffset: '2px',
    respectsReducedMotion: true,
  },

  uiStates: [
    'loading',
    'empty',
    'error',
    'success',
    'disabled',
    'interactive',
  ] as const,
} as const;

export type DesignTheme = (typeof DESIGN_TOKENS.color.themes)[number];
export type DesignUiState = (typeof DESIGN_TOKENS.uiStates)[number];
export type IconSizeToken = keyof typeof DESIGN_TOKENS.iconography.sizes;
