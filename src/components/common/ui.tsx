import React, { useEffect, useRef } from 'react';
import { AlertTriangle, CheckCircle2, Inbox, Info, X } from 'lucide-react';

/**
 * Small, dependency-free presentation primitives.
 * These do not compute or mutate any financial value; they only standardise the
 * chrome (headers, cards, empty states, status pills, alerts) across screens.
 */

export type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger' | 'purple';

const TONE_BADGE: Record<Tone, string> = {
  neutral:
    'bg-slate-100 text-slate-600 dark:bg-white/[0.07] dark:text-slate-300',
  info: 'bg-brand-50 text-brand-700 dark:bg-brand-500/15 dark:text-brand-300',
  success:
    'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300',
  warning: 'bg-amber-50 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300',
  danger: 'bg-rose-50 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300',
  purple: 'bg-purple-50 text-purple-700 dark:bg-purple-500/15 dark:text-purple-300',
};

export const StatusBadge: React.FC<{ tone?: Tone; children: React.ReactNode; className?: string }> = ({
  tone = 'neutral',
  children,
  className = '',
}) => <span className={`badge ${TONE_BADGE[tone]} ${className}`}>{children}</span>;

export const PageHeader: React.FC<{
  title: string;
  subtitle?: string;
  icon?: React.ReactNode;
  actions?: React.ReactNode;
}> = ({ title, subtitle, icon, actions }) => (
  <div className="flex flex-wrap items-start justify-between gap-4">
    <div className="min-w-0">
      <div className="flex items-center gap-2.5">
        {icon && (
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-brand-50 text-brand-600 ring-1 ring-brand-100 ring-inset dark:bg-brand-500/10 dark:text-brand-300 dark:ring-brand-500/20">
            {icon}
          </span>
        )}
        <h1 className="text-[22px] font-bold leading-tight tracking-tight text-slate-900 dark:text-white">
          {title}
        </h1>
      </div>
      {subtitle && (
        <p className="mt-1.5 max-w-3xl text-[13px] leading-relaxed text-slate-500 dark:text-slate-400">
          {subtitle}
        </p>
      )}
    </div>
    {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
  </div>
);

export const Panel: React.FC<{
  title?: string;
  description?: string;
  icon?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
  bodyClassName?: string;
  children: React.ReactNode;
}> = ({ title, description, icon, actions, className = '', bodyClassName = '', children }) => (
  <section className={`surface overflow-hidden ${className}`}>
    {(title || actions) && (
      <div className="surface-header">
        <div className="min-w-0">
          {title && (
            <h2 className="section-title flex items-center gap-2">
              {icon}
              <span>{title}</span>
            </h2>
          )}
          {description && (
            <p className="mt-0.5 text-[11px] leading-relaxed text-slate-500 dark:text-slate-400">
              {description}
            </p>
          )}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
    )}
    <div className={bodyClassName || 'p-5'}>{children}</div>
  </section>
);

export const StatCard: React.FC<{
  label: string;
  value: React.ReactNode;
  hint?: React.ReactNode;
  icon?: React.ReactNode;
  tone?: 'neutral' | 'blue' | 'emerald' | 'amber' | 'rose';
  loading?: boolean;
}> = ({ label, value, hint, icon, tone = 'neutral', loading }) => {
  const valueTone =
    tone === 'blue'
      ? 'text-brand-600 dark:text-brand-400'
      : tone === 'emerald'
      ? 'text-emerald-600 dark:text-emerald-400'
      : tone === 'amber'
      ? 'text-amber-600 dark:text-amber-400'
      : tone === 'rose'
      ? 'text-rose-600 dark:text-rose-400'
      : 'text-slate-900 dark:text-white';

  const iconTone =
    tone === 'blue'
      ? 'bg-brand-50 text-brand-600 dark:bg-brand-500/10 dark:text-brand-300'
      : tone === 'emerald'
      ? 'bg-emerald-50 text-emerald-600 dark:bg-emerald-500/10 dark:text-emerald-300'
      : tone === 'amber'
      ? 'bg-amber-50 text-amber-600 dark:bg-amber-500/10 dark:text-amber-300'
      : tone === 'rose'
      ? 'bg-rose-50 text-rose-600 dark:bg-rose-500/10 dark:text-rose-300'
      : 'bg-slate-100 text-slate-500 dark:bg-white/[0.07] dark:text-slate-300';

  return (
    <div className="surface surface-hover flex min-h-[124px] flex-col justify-between p-5">
      <div className="flex items-start justify-between gap-3">
        <span className="text-[11px] font-bold tracking-[0.07em] text-slate-500 uppercase dark:text-slate-400">
          {label}
        </span>
        {icon && (
          <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-xl ${iconTone}`}>
            {icon}
          </span>
        )}
      </div>
      {loading ? (
        <div className="skeleton mt-3 h-8 w-32" />
      ) : (
        <div className={`mt-2 font-mono text-[26px] font-bold leading-none tabular-nums ${valueTone}`}>
          {value}
        </div>
      )}
      {hint && <div className="mt-2.5 min-h-[16px] text-[11px] text-slate-500 dark:text-slate-400">{hint}</div>}
    </div>
  );
};

export const EmptyState: React.FC<{
  title: string;
  description?: string;
  action?: React.ReactNode;
  icon?: React.ReactNode;
}> = ({ title, description, action, icon }) => (
  <div className="flex flex-col items-center justify-center px-4 py-14 text-center">
    <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-slate-100 text-slate-400 ring-1 ring-slate-200/70 ring-inset dark:bg-white/[0.05] dark:text-slate-500 dark:ring-white/[0.06]">
      {icon || <Inbox className="h-6 w-6" />}
    </div>
    <div className="text-sm font-semibold text-slate-800 dark:text-slate-100">{title}</div>
    {description && (
      <p className="mt-1.5 max-w-sm text-[13px] leading-relaxed text-slate-500 dark:text-slate-400">
        {description}
      </p>
    )}
    {action && <div className="mt-4">{action}</div>}
  </div>
);

export const InlineAlert: React.FC<{
  tone?: 'error' | 'warning' | 'success' | 'info';
  children: React.ReactNode;
  onDismiss?: () => void;
}> = ({ tone = 'info', children, onDismiss }) => {
  const styles =
    tone === 'error'
      ? 'border-rose-200 bg-rose-50 text-rose-800 dark:border-rose-500/25 dark:bg-rose-500/10 dark:text-rose-200'
      : tone === 'warning'
      ? 'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-500/25 dark:bg-amber-500/10 dark:text-amber-200'
      : tone === 'success'
      ? 'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-500/25 dark:bg-emerald-500/10 dark:text-emerald-200'
      : 'border-brand-200 bg-brand-50 text-brand-800 dark:border-brand-500/25 dark:bg-brand-500/10 dark:text-brand-200';

  const Icon = tone === 'success' ? CheckCircle2 : tone === 'info' ? Info : AlertTriangle;

  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className={`flex items-start justify-between gap-3 rounded-xl border p-3.5 text-[13px] leading-relaxed ${styles}`}
    >
      <span className="flex items-start gap-2.5">
        <Icon className="mt-0.5 h-4 w-4 shrink-0" />
        <span className="min-w-0">{children}</span>
      </span>
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          className="shrink-0 rounded-md px-1.5 py-0.5 text-[11px] font-semibold underline underline-offset-2 opacity-70 transition-opacity hover:opacity-100"
        >
          Dismiss
        </button>
      )}
    </div>
  );
};

/* ---------------------------------------------------------------------------
   Modal primitives — shared shell, header, footer, two-column body, field
   --------------------------------------------------------------------------- */

interface ModalShellProps {
  open: boolean;
  onClose: () => void;
  titleId?: string;
  size?: 'sm' | 'md' | 'lg' | 'xl' | '2xl' | '3xl' | '4xl';
  children: React.ReactNode;
  className?: string;
}

export const ModalShell: React.FC<ModalShellProps> = ({
  open,
  onClose,
  titleId,
  size = 'lg',
  children,
  className = '',
}) => {
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  const widthClass: Record<string, string> = {
    sm: 'max-w-sm',
    md: 'max-w-md',
    lg: 'max-w-lg',
    xl: 'max-w-xl',
    '2xl': 'max-w-2xl',
    '3xl': 'max-w-3xl',
    '4xl': 'max-w-4xl',
  };

  useEffect(() => {
    if (!open) return;
    restoreFocusRef.current = document.activeElement as HTMLElement;
    // Focus the panel (or first focusable) on open
    const t = window.setTimeout(() => {
      const focusable = panelRef.current?.querySelector<HTMLElement>(
        'input, select, textarea, button, [tabindex]:not([tabindex="-1"])',
      );
      (focusable || panelRef.current)?.focus();
    }, 50);
    // Lock body scroll
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    // Escape closes
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
      // Focus trap
      if (e.key === 'Tab' && panelRef.current) {
        const focusable = panelRef.current.querySelectorAll<HTMLElement>(
          'input:not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), [tabindex]:not([tabindex="-1"])',
        );
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
    document.addEventListener('keydown', onKey, true);
    return () => {
      window.clearTimeout(t);
      document.removeEventListener('keydown', onKey, true);
      document.body.style.overflow = prev;
      restoreFocusRef.current?.focus?.();
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-950/60 p-4 backdrop-blur-sm sm:p-6 md:p-8"
      onMouseDown={e => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={`animate-modal-enter relative flex max-h-[92vh] w-full ${widthClass[size]} flex-col overflow-hidden rounded-2xl border border-slate-200/80 bg-white shadow-pop outline-none dark:border-white/[0.08] dark:bg-slate-900 ${className}`}
      >
        {children}
      </div>
    </div>
  );
};

interface ModalHeaderProps {
  title: string;
  subtitle?: string;
  icon?: React.ReactNode;
  tone?: 'brand' | 'emerald' | 'amber' | 'rose' | 'slate';
  onClose: () => void;
}

export const ModalHeader: React.FC<ModalHeaderProps> = ({
  title,
  subtitle,
  icon,
  tone = 'brand',
  onClose,
}) => {
  const toneClass: Record<string, string> = {
    brand: 'from-brand-700 via-brand-800 to-brand-950',
    emerald: 'from-emerald-700 via-emerald-800 to-emerald-950',
    amber: 'from-amber-600 via-amber-700 to-amber-900',
    rose: 'from-rose-700 via-rose-800 to-rose-950',
    slate: 'from-slate-800 via-slate-900 to-slate-950',
  };
  return (
    <div
      className={`flex shrink-0 items-start justify-between gap-3 bg-gradient-to-br ${toneClass[tone]} px-5 py-4 text-white`}
    >
      <div className="flex min-w-0 items-start gap-3">
        {icon && (
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-white/15 ring-1 ring-white/20 ring-inset">
            {icon}
          </span>
        )}
        <div className="min-w-0">
          <h2 className="truncate text-[15px] font-bold leading-tight tracking-tight">{title}</h2>
          {subtitle && (
            <p className="mt-0.5 text-[11px] leading-relaxed text-white/70">{subtitle}</p>
          )}
        </div>
      </div>
      <button
        type="button"
        onClick={onClose}
        aria-label="Close dialog"
        className="shrink-0 rounded-lg p-1.5 text-white/70 transition-colors hover:bg-white/15 hover:text-white"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
};

interface ModalFooterProps {
  onCancel: () => void;
  submitLabel?: string;
  submitIcon?: React.ReactNode;
  onSubmit?: () => void;
  form?: string;
  disabled?: boolean;
  busy?: boolean;
  left?: React.ReactNode;
  tone?: 'brand' | 'emerald' | 'rose' | 'slate';
}

export const ModalFooter: React.FC<ModalFooterProps> = ({
  onCancel,
  submitLabel = 'Save',
  submitIcon,
  onSubmit,
  form,
  disabled,
  busy,
  left,
  tone = 'brand',
}) => {
  const submitClass: Record<string, string> = {
    brand: 'btn btn-primary',
    emerald: 'btn btn-emerald',
    rose: 'btn btn-danger',
    slate: 'btn bg-slate-800 text-white hover:bg-slate-700 dark:bg-white dark:text-slate-900 dark:hover:bg-slate-200',
  };
  return (
    <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t border-slate-200/70 bg-slate-50/60 px-5 py-3.5 dark:border-white/[0.06] dark:bg-white/[0.02]">
      <div className="min-w-0">{left}</div>
      <div className="flex items-center gap-2">
        <button type="button" onClick={onCancel} className="btn btn-secondary">
          Cancel
        </button>
        <button
          type="submit"
          form={form}
          onClick={onSubmit}
          disabled={disabled || busy}
          className={submitClass[tone]}
        >
          {busy ? (
            <>
              <svg className="h-3.5 w-3.5 animate-spin" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
              </svg>
              Saving...
            </>
          ) : (
            <>
              {submitIcon}
              {submitLabel}
            </>
          )}
        </button>
      </div>
    </div>
  );
};

interface ModalBodyProps {
  children: React.ReactNode;
  className?: string;
  columns?: 1 | 2 | 3;
}

export const ModalBody: React.FC<ModalBodyProps> = ({ children, className = '', columns = 1 }) => {
  const colClass =
    columns === 2
      ? 'lg:grid-cols-[1fr_320px]'
      : columns === 3
      ? 'lg:grid-cols-[1fr_320px_280px]'
      : '';
  return (
    <div className={`flex-1 overflow-y-auto ${className}`}>
      <div className={`grid gap-5 p-5 ${colClass}`}>{children}</div>
    </div>
  );
};

interface FormSectionProps {
  title?: string;
  icon?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  aside?: boolean;
}

export const FormSection: React.FC<FormSectionProps> = ({
  title,
  icon,
  children,
  className = '',
  aside = false,
}) => (
  <section
    className={
      aside
        ? `surface p-4 ${className}`
        : `space-y-3 ${className}`
    }
  >
    {title && (
      <h3
        className={`flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-[0.09em] ${
          aside ? 'mb-2 text-slate-500 dark:text-slate-400' : 'text-slate-500 dark:text-slate-400'
        }`}
      >
        {icon}
        {title}
      </h3>
    )}
    {children}
  </section>
);

interface FormFieldProps {
  label: string;
  required?: boolean;
  hint?: string;
  error?: string;
  children: React.ReactNode;
  className?: string;
}

export const FormField: React.FC<FormFieldProps> = ({
  label,
  required,
  hint,
  error,
  children,
  className = '',
}) => (
  <div className={className}>
    <label className="app-label">
      {label}
      {required && <span className="ml-0.5 text-rose-500">*</span>}
    </label>
    {children}
    {error ? (
      <p className="mt-1 text-[11px] font-medium text-rose-600 dark:text-rose-400">{error}</p>
    ) : hint ? (
      <p className="mt-1 text-[11px] text-slate-400 dark:text-slate-500">{hint}</p>
    ) : null}
  </div>
);

interface SummaryRowProps {
  label: string;
  value: React.ReactNode;
  emphasis?: boolean;
  tone?: 'neutral' | 'emerald' | 'rose' | 'brand' | 'amber';
}

export const SummaryRow: React.FC<SummaryRowProps> = ({
  label,
  value,
  emphasis,
  tone = 'neutral',
}) => {
  const valueClass: Record<string, string> = {
    neutral: emphasis ? 'text-slate-900 dark:text-white' : 'text-slate-600 dark:text-slate-300',
    emerald: 'text-emerald-600 dark:text-emerald-400',
    rose: 'text-rose-600 dark:text-rose-400',
    brand: 'text-brand-600 dark:text-brand-400',
    amber: 'text-amber-600 dark:text-amber-400',
  };
  return (
    <div className={`flex items-center justify-between gap-2 py-1 ${emphasis ? 'border-t border-slate-200/70 pt-2 dark:border-white/[0.06]' : ''}`}>
      <span className="text-[12px] text-slate-500 dark:text-slate-400">{label}</span>
      <span className={`font-mono text-[13px] font-semibold tabular-nums ${valueClass[tone]}`}>{value}</span>
    </div>
  );
};