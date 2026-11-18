import React from 'react';
import { Search } from 'lucide-react';
import type { HeaderTier } from '../../../hooks/useResponsiveHeader';

interface GlobalSearchProps {
  tier: HeaderTier;
  onOpen: () => void;
}

/**
 * Entry point to the existing Command Palette. Widths are handled by the
 * header breakpoints so the control never competes with navigation for room.
 */
export const GlobalSearch: React.FC<GlobalSearchProps> = ({ tier, onOpen }) => {
  if (tier === 'wide' || tier === 'medium') {
    return (
      <button
        type="button"
        className="hdr-search"
        onClick={onOpen}
        title="Search anything (Ctrl+K)"
        aria-label="Search records and open the Command Palette"
        aria-keyshortcuts="Control+K Meta+K"
      >
        <Search aria-hidden="true" className="hdr-search-icon" />
        <span className="hdr-search-label hdr-search-label-full">Search records…</span>
        <span className="hdr-search-label hdr-search-label-short">Search</span>
        <kbd className="hdr-search-kbd">Ctrl+K</kbd>
      </button>
    );
  }

  return (
    <button
      type="button"
      className="hdr-icon-btn"
      onClick={onOpen}
      title="Search anything (Ctrl+K)"
      aria-label="Search records and open the Command Palette"
      aria-keyshortcuts="Control+K Meta+K"
    >
      <Search aria-hidden="true" className="h-4 w-4" />
    </button>
  );
};
