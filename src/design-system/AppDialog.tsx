import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, CheckCircle2, Info, MessageSquare, X } from 'lucide-react';
import type { ActionConfirmation } from '../actions/types';

export type AppDialogTone = 'brand' | 'emerald' | 'amber' | 'rose' | 'slate';

export interface ConfirmDialogOptions {
  title: string;
  message: string;
  impactSummary?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  tone?: AppDialogTone;
}

export interface PromptDialogOptions extends ConfirmDialogOptions {
  label?: string;
  placeholder?: string;
  defaultValue?: string;
  required?: boolean;
  requiredMessage?: string;
  multiline?: boolean;
  inputType?: 'text' | 'password' | 'number' | 'date';
}

export interface AlertDialogOptions {
  title: string;
  message: string;
  closeLabel?: string;
  tone?: AppDialogTone;
}

type DialogRequest =
  | {
      kind: 'confirm';
      options: ConfirmDialogOptions;
      resolve: (confirmed: boolean) => void;
    }
  | {
      kind: 'prompt';
      options: PromptDialogOptions;
      resolve: (value: string | null) => void;
    }
  | {
      kind: 'alert';
      options: AlertDialogOptions;
      resolve: () => void;
    };

type DialogListener = (queue: DialogRequest[]) => void;

const dialogQueue: DialogRequest[] = [];
const listeners = new Set<DialogListener>();

function emitQueue() {
  const snapshot = [...dialogQueue];
  listeners.forEach(listener => listener(snapshot));
}

function enqueue<T>(request: DialogRequest): Promise<T> {
  // In headless unit tests without AppDialogHost mounted, avoid hanging tests forever.
  if (listeners.size === 0) {
    if (request.kind === 'confirm') {
      request.resolve(true);
      return Promise.resolve(true as unknown as T);
    }
    if (request.kind === 'prompt') {
      request.resolve(request.options.defaultValue ?? '');
      return Promise.resolve((request.options.defaultValue ?? '') as unknown as T);
    }
    request.resolve();
    return Promise.resolve(undefined as unknown as T);
  }
  dialogQueue.push(request);
  emitQueue();
  return undefined as unknown as Promise<T>;
}

/**
 * Imperative, accessible, non-blocking in-app dialog API.
 * Replaces native browser `window.confirm`, `window.prompt`, and `window.alert`
 * (which are suppressed in embedded iframes and fail accessibility & theme consistency).
 */
export const appDialog = {
  confirm(options: ConfirmDialogOptions | string): Promise<boolean> {
    const normalized: ConfirmDialogOptions =
      typeof options === 'string'
        ? { title: 'Confirm Action', message: options }
        : options;
    return new Promise<boolean>(resolve => {
      void enqueue({ kind: 'confirm', options: normalized, resolve });
    });
  },

  prompt(options: PromptDialogOptions | string, defaultValue = ''): Promise<string | null> {
    const normalized: PromptDialogOptions =
      typeof options === 'string'
        ? { title: 'Input Required', message: options, defaultValue }
        : options;
    return new Promise<string | null>(resolve => {
      void enqueue({ kind: 'prompt', options: normalized, resolve });
    });
  },

  alert(options: AlertDialogOptions | string): Promise<void> {
    const normalized: AlertDialogOptions =
      typeof options === 'string'
        ? { title: 'Notice', message: options }
        : options;
    return new Promise<void>(resolve => {
      void enqueue({ kind: 'alert', options: normalized, resolve });
    });
  },
};

/**
 * Shared confirmation helper for AdvancedActionsMenu callers (`InvoicesView`, `BillsView`, etc.).
 * Returns `{ confirmed: false }` if cancelled, or `{ confirmed: true, reason }` if confirmed.
 */
export async function confirmActionModal(
  confirmation: ActionConfirmation
): Promise<{ confirmed: boolean; reason?: string }> {
  if (confirmation.requireReason || confirmation.reasonLabel) {
    const value = await appDialog.prompt({
      title: confirmation.title,
      message: confirmation.message,
      impactSummary: confirmation.impactSummary,
      label: confirmation.reasonLabel || (confirmation.requireReason ? 'Reason (required)' : 'Reason (optional)'),
      placeholder: confirmation.reasonPlaceholder || 'Enter a reason…',
      required: Boolean(confirmation.requireReason),
      requiredMessage: 'A reason is required to continue.',
      confirmLabel: confirmation.confirmLabel || 'Confirm',
      cancelLabel: confirmation.cancelLabel || 'Cancel',
      destructive: Boolean(confirmation.destructive),
      multiline: true,
    });
    if (value === null) return { confirmed: false };
    const trimmed = value.trim();
    return { confirmed: true, reason: trimmed || undefined };
  }

  const confirmed = await appDialog.confirm({
    title: confirmation.title,
    message: confirmation.message,
    impactSummary: confirmation.impactSummary,
    confirmLabel: confirmation.confirmLabel || 'Confirm',
    cancelLabel: confirmation.cancelLabel || 'Cancel',
    destructive: Boolean(confirmation.destructive),
  });
  return { confirmed };
}

function dequeue(item: DialogRequest) {
  const index = dialogQueue.indexOf(item);
  if (index >= 0) {
    dialogQueue.splice(index, 1);
    emitQueue();
  }
}

export const AppDialogHost: React.FC = () => {
  const [queue, setQueue] = useState<DialogRequest[]>([]);
  const [inputValue, setInputValue] = useState('');
  const [validationError, setValidationError] = useState<string | null>(null);

  const panelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  const confirmBtnRef = useRef<HTMLButtonElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    listeners.add(setQueue);
    return () => {
      listeners.delete(setQueue);
    };
  }, []);

  const current = queue[0] ?? null;

  useEffect(() => {
    if (!current) return;
    restoreFocusRef.current = document.activeElement as HTMLElement | null;
    if (current.kind === 'prompt') {
      setInputValue(current.options.defaultValue ?? '');
      setValidationError(null);
    }
    const timer = window.setTimeout(() => {
      if (current.kind === 'prompt') {
        inputRef.current?.focus();
        inputRef.current?.select?.();
      } else {
        confirmBtnRef.current?.focus();
      }
    }, 10);

    return () => {
      window.clearTimeout(timer);
      const restore = restoreFocusRef.current;
      if (restore && document.body.contains(restore)) {
        window.setTimeout(() => restore.focus(), 0);
      }
    };
  }, [current]);

  if (!current) return null;

  const dismiss = () => {
    if (current.kind === 'confirm') {
      current.resolve(false);
    } else if (current.kind === 'prompt') {
      current.resolve(null);
    } else {
      current.resolve();
    }
    dequeue(current);
  };

  const submit = () => {
    if (current.kind === 'confirm') {
      current.resolve(true);
      dequeue(current);
      return;
    }
    if (current.kind === 'alert') {
      current.resolve();
      dequeue(current);
      return;
    }
    const raw = inputValue;
    if (current.options.required && !raw.trim()) {
      setValidationError(current.options.requiredMessage || 'This field is required.');
      inputRef.current?.focus();
      return;
    }
    current.resolve(raw);
    dequeue(current);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      dismiss();
      return;
    }
    if (e.key === 'Tab' && panelRef.current) {
      const focusable = Array.from(
        panelRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )
      ).filter(el => el.getClientRects().length > 0);
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  };

  const isDestructive =
    current.kind !== 'alert' && Boolean(current.options.destructive);
  const tone: AppDialogTone =
    current.options.tone ?? (isDestructive ? 'rose' : current.kind === 'prompt' ? 'brand' : 'brand');

  const iconToneMap: Record<AppDialogTone, string> = {
    brand: 'bg-brand-50 text-brand-600 ring-brand-100 dark:bg-brand-500/10 dark:text-brand-300 dark:ring-brand-500/20',
    emerald: 'bg-emerald-50 text-emerald-700 ring-emerald-100 dark:bg-emerald-500/10 dark:text-emerald-300 dark:ring-emerald-500/20',
    amber: 'bg-amber-50 text-amber-700 ring-amber-100 dark:bg-amber-500/10 dark:text-amber-300 dark:ring-amber-500/20',
    rose: 'bg-rose-50 text-rose-700 ring-rose-100 dark:bg-rose-500/10 dark:text-rose-300 dark:ring-rose-500/20',
    slate: 'bg-slate-100 text-slate-600 ring-slate-200 dark:bg-white/[0.06] dark:text-slate-300 dark:ring-white/10',
  };

  const HeaderIcon =
    tone === 'rose' || tone === 'amber'
      ? AlertTriangle
      : tone === 'emerald'
      ? CheckCircle2
      : current.kind === 'prompt'
      ? MessageSquare
      : Info;

  const titleId = 'app-dialog-title';
  const descId = 'app-dialog-desc';
  const inputId = 'app-dialog-input';

  const content = (
    <div
      className="fixed inset-0 z-[10050] flex items-center justify-center bg-slate-950/60 p-4 backdrop-blur-xs"
      onMouseDown={e => {
        if (e.target === e.currentTarget) dismiss();
      }}
      onKeyDown={onKeyDown}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descId}
        tabIndex={-1}
        className="animate-modal-enter w-full max-w-md overflow-hidden rounded-2xl border border-slate-200/80 bg-[#fcfcfd] shadow-2xl outline-none dark:border-white/[0.08] dark:bg-slate-900"
      >
        <div className="flex items-start justify-between gap-3 border-b border-slate-200/80 bg-white px-5 py-4 dark:border-white/[0.06] dark:bg-slate-900">
          <div className="flex min-w-0 items-start gap-3">
            <span
              className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ring-1 ring-inset ${iconToneMap[tone]}`}
              aria-hidden="true"
            >
              <HeaderIcon className="h-[18px] w-[18px]" strokeWidth={1.75} />
            </span>
            <div className="min-w-0">
              <h2
                id={titleId}
                className="text-[17px] font-semibold leading-snug tracking-tight text-slate-900 dark:text-white"
              >
                {current.options.title}
              </h2>
            </div>
          </div>
          <button
            type="button"
            onClick={dismiss}
            aria-label="Close dialog"
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-white/10 dark:hover:text-white"
          >
            <X className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
          </button>
        </div>

        <div className="space-y-4 px-5 py-4">
          <p
            id={descId}
            className="whitespace-pre-wrap text-[13px] leading-relaxed text-slate-700 dark:text-slate-300"
          >
            {current.options.message}
          </p>

          {current.kind !== 'alert' && current.options.impactSummary && (
            <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-[12px] leading-relaxed text-slate-600 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-slate-300">
              {current.options.impactSummary}
            </div>
          )}

          {current.kind === 'prompt' && (
            <div>
              {current.options.label && (
                <label htmlFor={inputId} className="app-label">
                  {current.options.label}
                  {current.options.required && <span className="ml-0.5 text-rose-600">*</span>}
                </label>
              )}
              {current.options.multiline ? (
                <textarea
                  id={inputId}
                  ref={el => {
                    inputRef.current = el;
                  }}
                  rows={3}
                  value={inputValue}
                  onChange={e => {
                    setInputValue(e.target.value);
                    if (validationError) setValidationError(null);
                  }}
                  placeholder={current.options.placeholder}
                  aria-invalid={Boolean(validationError)}
                  className="app-input"
                />
              ) : (
                <input
                  id={inputId}
                  ref={el => {
                    inputRef.current = el;
                  }}
                  type={current.options.inputType || 'text'}
                  value={inputValue}
                  onChange={e => {
                    setInputValue(e.target.value);
                    if (validationError) setValidationError(null);
                  }}
                  onKeyDown={e => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      submit();
                    }
                  }}
                  placeholder={current.options.placeholder}
                  aria-invalid={Boolean(validationError)}
                  className="app-input"
                />
              )}
              {validationError && (
                <p role="alert" className="mt-1.5 text-[11px] font-medium text-rose-600 dark:text-rose-400">
                  {validationError}
                </p>
              )}
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-slate-200/80 bg-slate-50/70 px-5 py-3.5 dark:border-white/[0.06] dark:bg-white/[0.02]">
          {current.kind !== 'alert' && (
            <button type="button" onClick={dismiss} className="btn btn-secondary">
              {current.options.cancelLabel || 'Cancel'}
            </button>
          )}
          <button
            ref={confirmBtnRef}
            type="button"
            onClick={submit}
            className={
              isDestructive
                ? 'btn bg-rose-600 text-white shadow-sm hover:bg-rose-700'
                : 'btn btn-primary'
            }
          >
            {current.kind === 'alert'
              ? current.options.closeLabel || 'OK'
              : current.options.confirmLabel || 'Confirm'}
          </button>
        </div>
      </div>
    </div>
  );

  return createPortal(content, document.body);
};
