import React, { useEffect, useState } from 'react';
import { Loader2, ShieldCheck } from 'lucide-react';
import type { AuditLoader, TransactionAuditEntryView, TransactionRef } from './types';

/**
 * TransactionAuditTimeline (read-only)
 * -----------------------------------------------------------------------------
 * Purely presentational. It receives ALREADY-SCOPED entries and never fetches or
 * filters a global audit list. Record-scoped retrieval is the responsibility of
 * an injected, AUTHORIZED `AuditLoader` (see useTransactionAudit).
 *
 * Phase 1 note / backend enhancement (requires separate approval): the existing
 * `GET /api/audit/logs` returns company-wide rows (no record filter) and omits
 * old/changed values. A record-scoped endpoint returning before/after values is
 * tracked as a backend enhancement; until then modules may inject a loader that
 * uses whatever authorized, record-scoped source exists.
 */

export interface TransactionAuditTimelineProps {
  entries: TransactionAuditEntryView[];
  loading?: boolean;
  error?: string | null;
  /** Shown when no authorized record-scoped source is configured. */
  notice?: string | null;
  emptyMessage?: string;
}

const formatTime = (iso: string): string => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
};

export const TransactionAuditTimeline: React.FC<TransactionAuditTimelineProps> = ({
  entries,
  loading = false,
  error = null,
  notice = null,
  emptyMessage = 'No audit history is available for this transaction.',
}) => {
  if (loading) {
    return (
      <div className="flex items-center gap-2 text-xs text-slate-500">
        <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading audit history…
      </div>
    );
  }
  if (error) {
    return <div className="text-xs text-rose-600">{error}</div>;
  }
  if (notice) {
    return (
      <div className="flex items-start gap-2 text-[11px] text-slate-500">
        <ShieldCheck className="w-3.5 h-3.5 mt-0.5 shrink-0" />
        <span>{notice}</span>
      </div>
    );
  }
  if (entries.length === 0) {
    return <div className="text-xs text-slate-400">{emptyMessage}</div>;
  }
  return (
    <ol className="relative space-y-2 border-l border-slate-200 dark:border-slate-700 pl-3">
      {entries.map((e) => (
        <li key={e.id} className="relative">
          <span className="absolute -left-[15px] top-1 h-2 w-2 rounded-full bg-[#1f8577]" />
          <div className="flex flex-wrap items-baseline justify-between gap-x-2">
            <span className="text-xs font-semibold text-slate-800 dark:text-slate-100">
              {e.action}
            </span>
            <span className="text-[10px] text-slate-400">{formatTime(e.occurredAt)}</span>
          </div>
          <div className="text-[11px] text-slate-500 dark:text-slate-400">
            {e.actorUsername || 'system'}
            {e.source ? ` · ${e.source}` : ''}
          </div>
        </li>
      ))}
    </ol>
  );
};

export interface UseTransactionAuditResult {
  entries: TransactionAuditEntryView[];
  loading: boolean;
  error: string | null;
  notice: string | null;
}

const NO_LOADER_NOTICE =
  'Record-scoped audit retrieval is not configured for this module. A backend ' +
  'enhancement (record-filtered, before/after values) is required.';

/**
 * Record-scoped audit hook. Calls the injected AUTHORIZED loader for the given
 * reference only — it never retrieves all audit rows and filters client-side.
 */
export function useTransactionAudit(
  loader: AuditLoader | undefined,
  ref: TransactionRef | null,
  enabled = true
): UseTransactionAuditResult {
  const [entries, setEntries] = useState<TransactionAuditEntryView[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled || !ref) return;
    if (!loader) {
      setEntries((prev) => (prev.length ? [] : prev));
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.resolve(loader(ref))
      .then((rows) => {
        if (!cancelled) setEntries(Array.isArray(rows) ? rows : []);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load audit history');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [loader, ref, enabled]);

  return { entries, loading, error, notice: loader ? null : NO_LOADER_NOTICE };
}