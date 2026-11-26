import React, { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import type { DetailField, DetailSection, DetailTone } from './types';

/**
 * TransactionDetailDrawer
 * -----------------------------------------------------------------------------
 * Extensible, module-agnostic detail framework. Modules compose `DetailSection[]`
 * (fields and/or fully custom content) so each transaction type keeps its own
 * layout — the framework never forces one identical shape.
 *
 * Accessibility: portal + backdrop, role="dialog", aria-modal, Escape to close,
 * focus trap, focus restore.
 */

const TONE_CLASS: Record<DetailTone, string> = {
  default: 'text-slate-900 dark:text-white',
  emerald: 'text-emerald-600 dark:text-emerald-400',
  rose: 'text-rose-600 dark:text-rose-400',
  amber: 'text-amber-600 dark:text-amber-400',
  teal: 'text-[#1f8577] dark:text-[#5ec2b3]',
  muted: 'text-slate-500 dark:text-slate-400',
};

const SPAN_CLASS: Record<1 | 2 | 3 | 4, string> = {
  1: 'sm:col-span-1',
  2: 'sm:col-span-2',
  3: 'sm:col-span-3',
  4: 'sm:col-span-4',
};

const Field: React.FC<{ field: DetailField }> = ({ field }) => (
  <div className={field.span ? SPAN_CLASS[field.span] : 'sm:col-span-1'}>
    <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
      {field.label}
    </div>
    <div
      className={`mt-0.5 text-xs ${field.mono ? 'font-mono' : ''} ${
        TONE_CLASS[field.tone ?? 'default']
      }`}
    >
      {field.value}
    </div>
  </div>
);

export interface TransactionDetailDrawerProps {
  open: boolean;
  onClose: () => void;
  title: React.ReactNode;
  number?: React.ReactNode;
  typeLabel?: React.ReactNode;
  statusBadge?: React.ReactNode;
  subtitle?: React.ReactNode;
  sections: DetailSection[];
  /** Primary actions area (e.g. a TransactionActionMenu + custom buttons). */
  actions?: React.ReactNode;
  /** Audit timeline slot (read-only). */
  audit?: React.ReactNode;
  /** Footer slot (e.g. "Open full transaction"). */
  footer?: React.ReactNode;
  onOpenFull?: () => void;
  widthClass?: string;
}

export const TransactionDetailDrawer: React.FC<TransactionDetailDrawerProps> = ({
  open,
  onClose,
  title,
  number,
  typeLabel,
  statusBadge,
  subtitle,
  sections,
  actions,
  audit,
  footer,
  onOpenFull,
  widthClass = 'w-full max-w-md',
}) => {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    previouslyFocused.current = document.activeElement as HTMLElement | null;
    const t = window.setTimeout(() => panelRef.current?.focus(), 0);
    return () => {
      window.clearTimeout(t);
      previouslyFocused.current?.focus?.();
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;
      const root = panelRef.current;
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
      } else if (active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[9998] flex justify-end bg-black/40"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        className={`h-full overflow-y-auto bg-white dark:bg-slate-900 border-l border-slate-200 dark:border-slate-700 shadow-2xl outline-none ${widthClass}`}
      >
        <div className="sticky top-0 z-10 flex items-start justify-between gap-3 border-b border-slate-200 dark:border-slate-700 bg-white/95 dark:bg-slate-900/95 px-4 py-3 backdrop-blur">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="truncate text-sm font-bold text-slate-900 dark:text-white">
                {title}
              </h2>
              {statusBadge}
            </div>
            <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-slate-500 dark:text-slate-400">
              {number != null && <span className="font-mono">{number}</span>}
              {typeLabel != null && <span>· {typeLabel}</span>}
            </div>
            {subtitle != null && <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{subtitle}</p>}
          </div>
          <button
            type="button"
            aria-label="Close details"
            onClick={onClose}
            className="p-1 rounded hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-500"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-4 space-y-4">
          {actions && (
            <div className="flex flex-wrap items-center gap-2 pb-1 border-b border-slate-100 dark:border-slate-800">
              {actions}
            </div>
          )}

          {sections.map((section) => (
            <section
              key={section.key}
              className="rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-3"
            >
              {section.title && (
                <h3 className="mb-2 text-[11px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                  {section.title}
                </h3>
              )}
              {section.fields && section.fields.length > 0 && (
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                  {section.fields.map((f, i) => (
                    <Field key={`${section.key}-${i}`} field={f} />
                  ))}
                </div>
              )}
              {section.content}
            </section>
          ))}

          {audit && (
            <section className="rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-3">
              <h3 className="mb-2 text-[11px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                Audit trail
              </h3>
              {audit}
            </section>
          )}
        </div>

        {(footer || onOpenFull) && (
          <div className="sticky bottom-0 border-t border-slate-200 dark:border-slate-700 bg-white/95 dark:bg-slate-900/95 px-4 py-3 backdrop-blur">
            {footer}
            {onOpenFull && (
              <button
                type="button"
                onClick={onOpenFull}
                className="mt-2 w-full rounded-md border border-slate-300 dark:border-slate-700 px-3 py-1.5 text-xs font-semibold text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800"
              >
                Open full transaction
              </button>
            )}
          </div>
        )}
      </div>
    </div>,
    document.body
  );
};