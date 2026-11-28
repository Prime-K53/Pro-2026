import React from 'react';
import { AlertTriangle, Loader2, WifiOff } from 'lucide-react';
import type { FinancialFigureState } from './financialDataState';

interface FinancialDataNoticeProps {
  state: FinancialFigureState;
  /** What the figures are, e.g. "purchasing data". Used in the message. */
  label: string;
  /** Re-run the authoritative load. Omit when no retry is available. */
  onRetry?: () => void;
  className?: string;
}

/**
 * Single, consistent way to tell the user that a financial figure cannot be
 * trusted right now.
 *
 * `ready` renders nothing so verified figures stay visually unchanged. The
 * `stale` and `unavailable` variants are mutually exclusive and always offer a
 * retry when one is supplied, so a failed load is never silent.
 */
export const FinancialDataNotice: React.FC<FinancialDataNoticeProps> = ({
  state,
  label,
  onRetry,
  className = '',
}) => {
  if (state === 'ready') return null;

  const retryButton = onRetry ? (
    <button
      type="button"
      onClick={onRetry}
      className="shrink-0 text-xs font-semibold underline hover:no-underline"
    >
      Retry
    </button>
  ) : null;

  if (state === 'loading') {
    return (
      <div
        role="status"
        className={`flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600 dark:border-white/10 dark:bg-slate-900/60 dark:text-slate-300 ${className}`}
      >
        <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-slate-400" />
        <span>Loading {label}…</span>
      </div>
    );
  }

  if (state === 'stale') {
    return (
      <div
        role="status"
        className={`flex items-center justify-between gap-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200 ${className}`}
      >
        <span className="flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          Showing stale {label} — the last refresh failed. Figures may be out of date.
        </span>
        {retryButton}
      </div>
    );
  }

  return (
    <div
      role="alert"
      className={`flex items-center justify-between gap-3 rounded-lg border border-rose-300 bg-rose-50 px-3 py-2 text-xs text-rose-800 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-200 ${className}`}
    >
      <span className="flex items-center gap-2">
        <WifiOff className="h-4 w-4 shrink-0" />
        {label.charAt(0).toUpperCase() + label.slice(1)} unavailable — no figures can be shown.
      </span>
      {retryButton}
    </div>
  );
};