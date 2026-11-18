import { useEffect, useState } from 'react';

export type HeaderTier = 'wide' | 'medium' | 'compact' | 'mobile';

export interface ResponsiveHeaderState {
  tier: HeaderTier;
  width: number;
  /** Matches the existing sidebar behaviour: below 1024px it opens as a drawer. */
  isNarrow: boolean;
}

export function resolveHeaderTier(width: number): HeaderTier {
  if (width >= 1280) return 'wide';
  if (width >= 1024) return 'medium';
  if (width >= 640) return 'compact';
  return 'mobile';
}

/**
 * Tracks the header breakpoint without relying on CSS-only signals. The
 * navigation and quick-action tiers need to change their DOM structure, not
 * only their visual styling, so a media-query hook is the right fit.
 */
export function useResponsiveHeader(): ResponsiveHeaderState {
  const [width, setWidth] = useState(() =>
    typeof window === 'undefined' ? 1440 : window.innerWidth
  );

  useEffect(() => {
    let frame = 0;

    const handleResize = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => setWidth(window.innerWidth));
    };

    window.addEventListener('resize', handleResize);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener('resize', handleResize);
    };
  }, []);

  return {
    tier: resolveHeaderTier(width),
    width,
    isNarrow: width < 1024,
  };
}
