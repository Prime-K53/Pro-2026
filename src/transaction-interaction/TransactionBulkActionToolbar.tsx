import React, { useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CheckCircle2, Loader2, XCircle, AlertTriangle, MinusCircle } from 'lucide-react';
import type {
  ActionConfirmation,
  ActionEligibilityContext,
  AdvancedActionDefinition,
} from '../actions/types';
import { evaluateAction } from '../actions/evaluateActions';
import { executeResolvedAction } from '../actions/executeAction';
import type { BulkActionResult, BulkRecordOutcome, TransactionRef } from './types';

/**
 * TransactionBulkActionToolbar
 * -----------------------------------------------------------------------------
 * Framework bulk executor. Guarantees:
 *  - per-record permission + status eligibility (no assumption all are eligible)
 *  - idempotency per record (recordKey) via the authoritative executor
 *  - confirmation (with reason when required) before consequential runs
 *  - duplicate-submit prevention (busy guard)
 *  - explicit success / failed / skipped classification, safe partial-failure
 *
 * It performs NO business logic itself: each action's `execute` must call the
 * existing authorized service/endpoint.
 */

export interface TransactionBulkActionToolbarProps<TRecord = unknown> {
  definitions: readonly AdvancedActionDefinition<TRecord>[];
  records: TRecord[];
  getRef: (record: TRecord) => TransactionRef;
  buildContext: (record: TRecord) => ActionEligibilityContext<TRecord>;
  notify?: (message: string, tone?: 'success' | 'error' | 'warning' | 'info') => void;
  onResult?: (result: BulkActionResult) => void;
  className?: string;
}

interface ConfirmState {
  confirmation: ActionConfirmation;
  count: number;
  resolve: (value: { confirmed: boolean; reason?: string }) => void;
}

const reasonOf = (err: unknown): string =>
  err instanceof Error && err.message ? err.message : 'Operation failed';

export function TransactionBulkActionToolbar<TRecord = unknown>({
  definitions,
  records,
  getRef,
  buildContext,
  notify,
  onResult,
  className,
}: TransactionBulkActionToolbarProps<TRecord>) {
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [result, setResult] = useState<BulkActionResult | null>(null);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState<string | null>(null);

  const doNotify = (message: string, tone: 'success' | 'error' | 'warning' | 'info' = 'info') =>
    notify?.(message, tone);

  const requestConfirm = (confirmation: ActionConfirmation, count: number) =>
    new Promise<{ confirmed: boolean; reason?: string }>((resolve) => {
      setReason('');
      setReasonError(null);
      setConfirm({ confirmation, count, resolve });
    });

  const closeConfirm = (value: { confirmed: boolean; reason?: string }) => {
    setConfirm((prev) => {
      prev?.resolve(value);
      return null;
    });
    setReason('');
    setReasonError(null);
  };

  const runBulk = async (def: AdvancedActionDefinition<TRecord>) => {
    if (busyRef.current) return; // duplicate-submit prevention
    if (records.length === 0) return;

    // 1) Per-record eligibility using the authoritative engine.
    const plans = records.map((record) => {
      const ctx = buildContext(record);
      const evaluation = evaluateAction(def, ctx);
      return { record, ctx, evaluation };
    });

    const eligible = plans.filter(
      (p) => p.evaluation.visible && p.evaluation.enabled && p.evaluation.state === 'enabled'
    );
    const skipped: BulkRecordOutcome[] = plans
      .filter((p) => !eligible.includes(p))
      .map((p) => {
        const ref = getRef(p.record);
        const reason =
          p.evaluation.reason ||
          (p.evaluation.visible ? 'Not eligible for this record' : 'Not available for this record');
        return { id: ref.id, number: ref.number, status: 'skipped' as const, reason };
      });

    if (eligible.length === 0) {
      const empty: BulkActionResult = {
        actionId: def.id,
        total: records.length,
        succeeded: [],
        failed: [],
        skipped,
      };
      setResult(empty);
      onResult?.(empty);
      doNotify('No selected transactions are eligible for this action.', 'warning');
      return;
    }

    // 2) Single confirmation for the whole run (reason captured once).
    let runReason: string | undefined;
    const confirmation = eligible[0].evaluation.confirmation;
    if (confirmation) {
      const res = await requestConfirm(confirmation, eligible.length);
      if (!res.confirmed) {
        const cancelled: BulkActionResult = {
          actionId: def.id,
          total: records.length,
          succeeded: [],
          failed: [],
          skipped: [
            ...skipped,
            ...eligible.map((p) => {
              const ref = getRef(p.record);
              return { id: ref.id, number: ref.number, status: 'skipped' as const, reason: 'Cancelled' };
            }),
          ],
        };
        setResult(cancelled);
        onResult?.(cancelled);
        return;
      }
      if (confirmation.requireReason) {
        runReason = (res.reason || '').trim();
        if (!runReason) {
          doNotify('A reason is required.', 'error');
          return;
        }
      } else if (res.reason) {
        runReason = res.reason.trim() || undefined;
      }
    }

    // 3) Execute eligible records sequentially with per-record idempotency.
    busyRef.current = true;
    setBusy(true);
    const succeeded: BulkRecordOutcome[] = [];
    const failed: BulkRecordOutcome[] = [];
    try {
      for (const p of eligible) {
        const ref = getRef(p.record);
        try {
          const out = await executeResolvedAction({
            action: { definition: def, evaluation: p.evaluation },
            context: p.ctx,
            helpers: { notify: doNotify },
            recordKey: ref.id,
            requestConfirmation: async () => ({ confirmed: true, reason: runReason }),
          });
          if (out.status === 'success') {
            succeeded.push({ id: ref.id, number: ref.number, status: 'success', reason: out.message });
          } else if (out.status === 'error') {
            failed.push({ id: ref.id, number: ref.number, status: 'failed', reason: out.message || 'Failed' });
          } else {
            skipped.push({ id: ref.id, number: ref.number, status: 'skipped', reason: out.message || 'Skipped' });
          }
        } catch (err) {
          failed.push({ id: ref.id, number: ref.number, status: 'failed', reason: reasonOf(err) });
        }
      }
    } finally {
      busyRef.current = false;
      setBusy(false);
    }

    const summary: BulkActionResult = {
      actionId: def.id,
      total: records.length,
      succeeded,
      failed,
      skipped,
    };
    setResult(summary);
    onResult?.(summary);
    const parts = [
      `${succeeded.length} succeeded`,
      failed.length ? `${failed.length} failed` : null,
      skipped.length ? `${skipped.length} skipped` : null,
    ].filter(Boolean);
    doNotify(parts.join(' · '), failed.length ? 'error' : succeeded.length ? 'success' : 'warning');
  };

  const submitConfirm = () => {
    if (!confirm) return;
    if (confirm.confirmation.requireReason && !reason.trim()) {
      setReasonError('A reason is required to continue.');
      return;
    }
    closeConfirm({ confirmed: true, reason: reason.trim() || undefined });
  };

  const confirmDialog = useMemo(() => {
    if (!confirm) return null;
    const { confirmation, count } = confirm;
    return createPortal(
      <div
        className="fixed inset-0 z-[10000] flex items-center justify-center p-4 bg-black/50"
        role="dialog"
        aria-modal="true"
        aria-label={confirmation.title}
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) closeConfirm({ confirmed: false });
        }}
      >
        <div className="w-full max-w-md rounded-xl border shadow-2xl bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-700 p-4 space-y-3">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h3 className="text-sm font-bold text-slate-900 dark:text-white">{confirmation.title}</h3>
              <p className="text-xs text-slate-600 dark:text-slate-300 mt-1 whitespace-pre-wrap">
                {confirmation.message}
              </p>
              <p className="text-[11px] text-slate-500 mt-1">
                This will run on {count} eligible transaction{count === 1 ? '' : 's'}.
              </p>
              {confirmation.impactSummary && (
                <p className="text-[11px] text-slate-500 mt-1">{confirmation.impactSummary}</p>
              )}
            </div>
            <button
              type="button"
              aria-label="Close confirmation"
              onClick={() => closeConfirm({ confirmed: false })}
              className="p-1 rounded hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-500"
            >
              <MinusCircle className="w-4 h-4" />
            </button>
          </div>
          {confirmation.requireReason && (
            <div className="space-y-1">
              <label className="text-xs font-semibold text-slate-700 dark:text-slate-200">
                {confirmation.reasonLabel || 'Reason'}
              </label>
              <textarea
                autoFocus
                value={reason}
                onChange={(e) => {
                  setReason(e.target.value);
                  if (reasonError) setReasonError(null);
                }}
                placeholder={confirmation.reasonPlaceholder || 'Enter a reason'}
                rows={3}
                className="w-full rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-2.5 py-2 text-xs text-slate-900 dark:text-slate-100 outline-none focus:ring-2 focus:ring-blue-500"
              />
              {reasonError && <div className="text-[11px] text-rose-600">{reasonError}</div>}
            </div>
          )}
          <div className="flex items-center justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={() => closeConfirm({ confirmed: false })}
              className="px-3 py-1.5 rounded-md border border-slate-300 dark:border-slate-700 text-xs font-semibold text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800"
            >
              {confirmation.cancelLabel || 'Cancel'}
            </button>
            <button
              type="button"
              onClick={submitConfirm}
              className={`px-3 py-1.5 rounded-md text-xs font-bold text-white ${
                confirmation.destructive ? 'bg-rose-600 hover:bg-rose-500' : 'bg-blue-600 hover:bg-blue-500'
              }`}
            >
              {confirmation.confirmLabel || 'Confirm'}
            </button>
          </div>
        </div>
      </div>,
      document.body
    );
  }, [confirm, reason, reasonError]);

  return (
    <div
      className={`flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 ${className || ''}`}
      role="toolbar"
      aria-label="Bulk actions"
    >
      <span className="text-[11px] font-semibold text-slate-500 dark:text-slate-400">
        {records.length} selected
      </span>
      <div className="flex flex-wrap items-center gap-1.5">
        {definitions.map((def) => (
          <button
            key={def.id}
            type="button"
            disabled={busy || records.length === 0}
            onClick={() => void runBulk(def)}
            title={def.description}
            className="inline-flex items-center gap-1 rounded-md border border-slate-300 dark:border-slate-700 px-2.5 py-1 text-[11px] font-semibold text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : def.icon}
            {def.label}
          </button>
        ))}
      </div>

      {result && (
        <div className="w-full mt-1 border-t border-slate-100 dark:border-slate-800 pt-2 space-y-1 text-[11px]">
          <div className="flex flex-wrap items-center gap-3">
            <span className="inline-flex items-center gap-1 text-emerald-600">
              <CheckCircle2 className="w-3.5 h-3.5" /> {result.succeeded.length} succeeded
            </span>
            <span className="inline-flex items-center gap-1 text-rose-600">
              <XCircle className="w-3.5 h-3.5" /> {result.failed.length} failed
            </span>
            <span className="inline-flex items-center gap-1 text-slate-500">
              <AlertTriangle className="w-3.5 h-3.5" /> {result.skipped.length} skipped
            </span>
          </div>
          {(result.failed.length > 0 || result.skipped.length > 0) && (
            <ul className="max-h-28 overflow-y-auto space-y-0.5 text-slate-500">
              {result.failed.map((r) => (
                <li key={`f-${r.id}`} className="text-rose-600">
                  Failed {r.number ?? r.id}: {r.reason}
                </li>
              ))}
              {result.skipped.map((r) => (
                <li key={`s-${r.id}`}>
                  Skipped {r.number ?? r.id}: {r.reason}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {confirmDialog}
    </div>
  );
}