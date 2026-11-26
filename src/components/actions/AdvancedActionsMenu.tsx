import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Loader2, MoreHorizontal, X } from 'lucide-react';
import { useAccounting } from '../../context/AccountingContext';
import type { ActionConfirmation, ActionEligibilityContext, ResolvedAdvancedAction } from '../../actions/types';
import { executeResolvedAction } from '../../actions/executeAction';
import { groupResolvedActions } from '../../actions/evaluateActions';

interface InternalConfirmState<TRecord = unknown> {
  action: ResolvedAdvancedAction<TRecord>;
  confirmation: ActionConfirmation;
  resolve: (value: { confirmed: boolean; reason?: string }) => void;
}

export interface AdvancedActionsMenuViewProps<TRecord = unknown> {
  actions: ResolvedAdvancedAction<TRecord>[];
  label?: string;
  className?: string;
  pendingActionId?: string | null;
  onExecuteAction?: (action: ResolvedAdvancedAction<TRecord>, reason?: string) => Promise<void> | void;
  /** Context used only for internal executor path (when onExecuteAction not provided). */
  executionContext?: ActionEligibilityContext<TRecord>;
  idempotencyRecordKey?: string | number | null;
  notify?: (message: string, tone?: 'success' | 'error' | 'warning' | 'info') => void;
  /** When provided, opens the menu as a context menu at this viewport point. */
  contextPoint?: { x: number; y: number } | null;
  onContextClose?: () => void;
  hideTrigger?: boolean;
}

export function AdvancedActionsMenu<TRecord = unknown>({
  actions,
  label = 'Row actions',
  className = '',
  pendingActionId = null,
  onExecuteAction,
  executionContext,
  idempotencyRecordKey,
  notify,
  contextPoint = null,
  onContextClose,
  hideTrigger = false,
}: AdvancedActionsMenuViewProps<TRecord>) {
  const { companyProfile, triggerShortcutNotice } = useAccounting();
  const isMidnight = companyProfile.theme === 'midnight';
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState<{ top: number; left: number; openUp: boolean; maxHeight: number }>({
    top: 0,
    left: 0,
    openUp: false,
    maxHeight: 320,
  });
  const [localPendingId, setLocalPendingId] = useState<string | null>(null);
  const [confirmState, setConfirmState] = useState<InternalConfirmState<TRecord> | null>(null);
  const [reasonInput, setReasonInput] = useState('');
  const [reasonError, setReasonError] = useState<string | null>(null);

  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const prevOpenRef = useRef(false);
  const confirmDialogRef = useRef<HTMLDivElement | null>(null);
  const confirmPrimaryRef = useRef<HTMLButtonElement | null>(null);
  const confirmCancelRef = useRef<HTMLButtonElement | null>(null);
  const reasonInputRef = useRef<HTMLTextAreaElement | null>(null);

  const effectivePendingId = pendingActionId ?? localPendingId;
  const visibleActions = useMemo(() => actions.filter((a) => a.evaluation.visible), [actions]);
  const grouped = useMemo(() => groupResolvedActions(visibleActions), [visibleActions]);
  const flatItems = useMemo(() => grouped.flatMap((g) => g.actions), [grouped]);

  const doNotify = (message: string, tone: 'success' | 'error' | 'warning' | 'info' = 'info') => {
    if (notify) notify(message, tone);
    else if (typeof triggerShortcutNotice === 'function') triggerShortcutNotice(message, tone);
  };

  const updatePosition = (point?: { x: number; y: number } | null) => {
    const menuWidth = 260;
    const margin = 8;
    const estimatedHeight = Math.min(Math.max(visibleActions.length, 1) * 36 + 24, 420);
    if (point) {
      const spaceBelow = Math.max(0, window.innerHeight - point.y - margin);
      const spaceAbove = Math.max(0, point.y - margin);
      const openUp = spaceBelow < Math.min(estimatedHeight, 200) && spaceAbove > spaceBelow;
      const maxHeight = Math.max(120, Math.min(420, openUp ? spaceAbove - 4 : spaceBelow - 4));
      const left = Math.max(margin, Math.min(point.x, window.innerWidth - menuWidth - margin));
      const top = openUp ? point.y : point.y;
      setCoords({ top, left, openUp, maxHeight });
      return;
    }
    const btn = buttonRef.current;
    if (!btn) return;
    const rect = btn.getBoundingClientRect();
    const spaceBelow = Math.max(0, window.innerHeight - rect.bottom - margin);
    const spaceAbove = Math.max(0, rect.top - margin);
    const openUp = spaceBelow < Math.min(estimatedHeight, 200) && spaceAbove > spaceBelow;
    const maxHeight = Math.max(120, Math.min(420, openUp ? spaceAbove - 4 : spaceBelow - 4));
    const left = Math.max(margin, Math.min(rect.right - menuWidth, window.innerWidth - menuWidth - margin));
    const top = openUp ? rect.top - 6 : rect.bottom + 6;
    setCoords({ top, left, openUp, maxHeight });
  };

  useEffect(() => {
    if (contextPoint) {
      updatePosition(contextPoint);
      setOpen(true);
    }
  }, [contextPoint?.x, contextPoint?.y, visibleActions.length]);

  useEffect(() => {
    if (prevOpenRef.current && !open && contextPoint) onContextClose?.();
    prevOpenRef.current = open;
  }, [open, contextPoint, onContextClose]);

  useEffect(() => {
    if (!open) return;
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        menuRef.current &&
        !menuRef.current.contains(target) &&
        buttonRef.current &&
        !buttonRef.current.contains(target)
      ) {
        setOpen(false);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (confirmState) return;
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    const handleScrollOrResize = (e: Event) => {
      if (e.type === 'scroll') {
        const target = e.target as Node | null;
        if (target && menuRef.current?.contains(target)) return;
      }
      setOpen(false);
    };
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKeyDown);
    window.addEventListener('scroll', handleScrollOrResize, true);
    window.addEventListener('resize', handleScrollOrResize);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('scroll', handleScrollOrResize, true);
      window.removeEventListener('resize', handleScrollOrResize);
    };
  }, [open, confirmState]);

  useEffect(() => {
    if (open) {
      const idx = flatItems.findIndex((a) => a.evaluation.enabled && a.evaluation.state === 'enabled');
      const target = idx >= 0 ? itemRefs.current[idx] : itemRefs.current[0];
      target?.focus();
    }
  }, [open, flatItems]);

  if (visibleActions.length === 0) return null;

  const requestConfirmation = (confirmation: ActionConfirmation, action: ResolvedAdvancedAction<TRecord>) =>
    new Promise<{ confirmed: boolean; reason?: string }>((resolve) => {
      setReasonInput('');
      setReasonError(null);
      setConfirmState({ action, confirmation, resolve });
    });

  const closeConfirm = (result: { confirmed: boolean; reason?: string }) => {
    if (confirmState) confirmState.resolve(result);
    setConfirmState(null);
    setReasonInput('');
    setReasonError(null);
  };

  const runAction = async (action: ResolvedAdvancedAction<TRecord>) => {
    if (effectivePendingId) return; // client-side duplicate submission protection
    if (!action.evaluation.enabled || action.evaluation.state === 'pending') return;

    if (onExecuteAction) {
      setLocalPendingId(action.definition.id);
      setOpen(false);
      try {
        await onExecuteAction(action);
      } catch (err: any) {
        doNotify(err?.message || 'Action failed', 'error');
      } finally {
        setLocalPendingId(null);
        buttonRef.current?.focus();
      }
      return;
    }

    if (typeof action.definition.execute !== 'function') {
      setOpen(false);
      return;
    }

    setOpen(false);
    setLocalPendingId(action.definition.id);
    try {
      const ctx: ActionEligibilityContext<TRecord> =
        executionContext || ({ authenticated: true, permissions: [] } as ActionEligibilityContext<TRecord>);
      const result = await executeResolvedAction({
        action,
        context: ctx,
        helpers: { notify: doNotify },
        requestConfirmation: async (confirmation) => requestConfirmation(confirmation, action),
        recordKey: idempotencyRecordKey,
      });
      if (result.status === 'error' && result.message) {
        // notify already called by executor; avoid duplicate spam
      }
    } catch (err: any) {
      doNotify(err?.message || 'Action failed', 'error');
    } finally {
      setLocalPendingId(null);
      buttonRef.current?.focus();
    }
  };

  const onMenuKeyDown = (e: React.KeyboardEvent) => {
    const enabledIndexes = flatItems
      .map((a, i) => ({ a, i }))
      .filter((x) => x.a.evaluation.enabled && x.a.evaluation.state !== 'pending')
      .map((x) => x.i);
    if (enabledIndexes.length === 0) return;
    const currentIndex = itemRefs.current.findIndex((el) => el === document.activeElement);
    const pos = Math.max(0, enabledIndexes.indexOf(currentIndex));
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const next = enabledIndexes[(pos + 1) % enabledIndexes.length];
      itemRefs.current[next]?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      const prev = enabledIndexes[(pos - 1 + enabledIndexes.length) % enabledIndexes.length];
      itemRefs.current[prev]?.focus();
    } else if (e.key === 'Home') {
      e.preventDefault();
      itemRefs.current[enabledIndexes[0]]?.focus();
    } else if (e.key === 'End') {
      e.preventDefault();
      itemRefs.current[enabledIndexes[enabledIndexes.length - 1]]?.focus();
    } else if (e.key === 'Tab') {
      setOpen(false);
    }
  };

  const renderConfirmDialog = () => {
    if (!confirmState) return null;
    const { confirmation, action } = confirmState;
    const requiresReason = confirmation.requireReason === true;
    const submit = () => {
      const trimmed = reasonInput.trim();
      if (requiresReason && !trimmed) {
        setReasonError('A reason is required to continue.');
        return;
      }
      closeConfirm({ confirmed: true, reason: trimmed || undefined });
    };

    const onDialogKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        closeConfirm({ confirmed: false });
        return;
      }
      if (e.key !== 'Tab') return;
      const root = confirmDialogRef.current;
      if (!root) return;
      const focusable = Array.from(
        root.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
        )
      ).filter((el) => !el.hasAttribute('disabled') && el.getAttribute('aria-hidden') !== 'true');
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey) {
        if (active === first || !root.contains(active)) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (active === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };

    return createPortal(
      <div
        className="fixed inset-0 z-[10000] flex items-center justify-center p-4 bg-black/50"
        role="dialog"
        aria-modal="true"
        aria-label={confirmation.title}
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) closeConfirm({ confirmed: false });
        }}
        onKeyDown={onDialogKeyDown}
      >
        <div
          ref={confirmDialogRef}
          className="w-full max-w-md rounded-xl border shadow-2xl bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-700 p-4 space-y-3"
        >
          <div className="flex items-start justify-between gap-3">
            <div>
              <h3 className="text-sm font-bold text-slate-900 dark:text-white">{confirmation.title}</h3>
              <p className="text-xs text-slate-600 dark:text-slate-300 mt-1 whitespace-pre-wrap">{confirmation.message}</p>
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
              <X className="w-4 h-4" />
            </button>
          </div>
          {requiresReason && (
            <div className="space-y-1">
              <label className="text-xs font-semibold text-slate-700 dark:text-slate-200">
                {confirmation.reasonLabel || 'Reason'}
              </label>
              <textarea
                ref={reasonInputRef}
                autoFocus
                value={reasonInput}
                onChange={(e) => {
                  setReasonInput(e.target.value);
                  if (reasonError) setReasonError(null);
                }}
                placeholder={confirmation.reasonPlaceholder || 'Enter a reason'}
                className="w-full rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-2.5 py-2 text-xs text-slate-900 dark:text-slate-100 outline-none focus:ring-2 focus:ring-blue-500"
                rows={3}
              />
              {reasonError && <div className="text-[11px] text-rose-600">{reasonError}</div>}
            </div>
          )}
          <div className="flex items-center justify-end gap-2 pt-1">
            <button
              ref={confirmCancelRef}
              type="button"
              onClick={() => closeConfirm({ confirmed: false })}
              className="px-3 py-1.5 rounded-md border border-slate-300 dark:border-slate-700 text-xs font-semibold text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800"
            >
              {confirmation.cancelLabel || 'Cancel'}
            </button>
            <button
              ref={confirmPrimaryRef}
              type="button"
              onClick={submit}
              className={`px-3 py-1.5 rounded-md text-xs font-bold text-white ${
                confirmation.destructive || action.definition.destructive
                  ? 'bg-rose-600 hover:bg-rose-500'
                  : 'bg-blue-600 hover:bg-blue-500'
              }`}
            >
              {confirmation.confirmLabel || 'Confirm'}
            </button>
          </div>
        </div>
      </div>,
      document.body
    );
  };

  useEffect(() => {
    if (!confirmState) return;
    const t = window.setTimeout(() => {
      if (confirmState.confirmation.requireReason) {
        reasonInputRef.current?.focus();
      } else {
        confirmPrimaryRef.current?.focus();
      }
    }, 0);
    return () => window.clearTimeout(t);
  }, [confirmState]);

  let flatIndex = -1;

  return (
    <div className={`inline-flex items-center justify-end ${className}`}>
      {!hideTrigger && (
        <button
          ref={buttonRef}
          type="button"
          aria-label={label}
          aria-expanded={open}
          aria-haspopup="menu"
          onClick={(e) => {
            e.stopPropagation();
            if (!open) {
              updatePosition();
              setOpen(true);
            } else {
              setOpen(false);
            }
          }}
          className={`inline-flex items-center justify-center w-7 h-7 rounded-md border transition-colors cursor-pointer ${
            open
              ? isMidnight
                ? 'bg-slate-700 border-slate-500 text-white'
                : 'bg-slate-200 border-slate-400 text-slate-900'
              : isMidnight
              ? 'bg-slate-800/80 border-slate-700 text-slate-300 hover:bg-slate-700 hover:text-white'
              : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-100 hover:text-slate-900'
          }`}
        >
          {effectivePendingId ? <Loader2 className="w-4 h-4 animate-spin" /> : <MoreHorizontal className="w-4 h-4" />}
        </button>
      )}

      {open &&
        createPortal(
          <div
            ref={menuRef}
            role="menu"
            aria-label={label}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={onMenuKeyDown}
            style={{
              position: 'fixed',
              top: coords.top,
              left: coords.left,
              maxHeight: coords.maxHeight,
              transform: coords.openUp ? 'translateY(-100%)' : 'none',
              zIndex: 9999,
            }}
            className={`w-[260px] overflow-y-auto overscroll-contain rounded-lg border shadow-xl py-1 text-xs ${
              isMidnight ? 'bg-slate-800 border-slate-700 text-slate-200' : 'bg-white border-slate-200 text-slate-700'
            }`}
          >
            {grouped.map((group, gi) => (
              <div key={group.key} role="group" aria-label={group.label || group.key}>
                {gi > 0 && (
                  <div className={`my-1 border-t ${isMidnight ? 'border-slate-700' : 'border-slate-100'}`} />
                )}
                {group.label && (
                  <div className={`px-3 pt-1 pb-0.5 text-[10px] font-bold uppercase tracking-wider ${isMidnight ? 'text-slate-400' : 'text-slate-500'}`}>
                    {group.label}
                  </div>
                )}
                {group.actions.map((item) => {
                  flatIndex += 1;
                  const idx = flatIndex;
                  const { definition: def, evaluation } = item;
                  const isPending = effectivePendingId === def.id || evaluation.state === 'pending';
                  const disabled = !evaluation.enabled || !!effectivePendingId;
                  const danger = def.destructive || def.risk === 'destructive';
                  const title = !evaluation.enabled && evaluation.reason ? evaluation.reason : def.description;
                  return (
                    <button
                      key={def.id}
                      ref={(el) => {
                        itemRefs.current[idx] = el;
                      }}
                      type="button"
                      role="menuitem"
                      aria-disabled={disabled}
                      aria-label={def.ariaLabel || def.label}
                      title={title}
                      disabled={disabled}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (disabled) return;
                        void runAction(item);
                      }}
                      className={`w-full flex items-start gap-2 px-3 py-1.5 text-left transition-colors ${
                        disabled
                          ? 'opacity-50 cursor-not-allowed'
                          : danger
                          ? isMidnight
                            ? 'text-rose-400 hover:bg-rose-950/50 cursor-pointer'
                            : 'text-rose-600 hover:bg-rose-50 cursor-pointer'
                          : isMidnight
                          ? 'hover:bg-slate-700/80 text-slate-200 cursor-pointer'
                          : 'hover:bg-slate-100 text-slate-700 cursor-pointer'
                      }`}
                    >
                      <span className="shrink-0 mt-0.5 opacity-80 w-4 h-4 inline-flex items-center justify-center">
                        {isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : def.icon}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium">{def.label}</span>
                        {def.description && <span className="block truncate text-[10px] opacity-70">{def.description}</span>}
                        {!evaluation.enabled && evaluation.reason && (
                          <span className="block truncate text-[10px] opacity-70">{evaluation.reason}</span>
                        )}
                      </span>
                    </button>
                  );
                })}
              </div>
            ))}
          </div>,
          document.body
        )}

      {renderConfirmDialog()}
    </div>
  );
}
