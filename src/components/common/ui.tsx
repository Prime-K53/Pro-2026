import React, { useEffect, useRef } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Inbox,
  Info,
  Loader2,
  RefreshCw,
  X,
  XCircle,
  type LucideIcon,
} from 'lucide-react';
import { DESIGN_TOKENS, type IconSizeToken } from '../../design-system/tokens';

/**
 * Prime Printing ERP — Unified Design System Component Primitives (Standards 01–10)
 * -----------------------------------------------------------------------------
 * Reusable, accessible, theme-aware UI building blocks governing typography,
 * contrast, spacing, iconography, interactive states, and dialogs.
 */

export type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger' | 'purple';

const TONE_BADGE: Record<Tone, string> = {
  neutral:
    'bg-slate-100 text-slate-700 dark:bg-white/[0.08] dark:text-slate-200',
  info: 'bg-brand-50 text-brand-700 dark:bg-brand-500/15 dark:text-brand-300',
  success:
    'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300',
  warning: 'bg-amber-50 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300',
  danger: 'bg-rose-50 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300',
  purple: 'bg-purple-50 text-purple-700 dark:bg-purple-500/15 dark:text-purple-300',
};

const TONE_ICON: Record<Tone, LucideIcon | null> = {
  neutral: null,
  info: Info,
  success: CheckCircle2,
  warning: AlertTriangle,
  danger: XCircle,
  purple: Info,
};

/* ---------------------------------------------------------------------------
   Standard Icon Wrapper (Standard 06: Iconography)
   --------------------------------------------------------------------------- */

export const AppIcon: React.FC<{
  icon: LucideIcon;
  size?: IconSizeToken;
  className?: string;
  decorative?: boolean;
  label?: string;
}> = ({ icon: Icon, size = 'sm', className = '', decorative = true, label }) => {
  const px = DESIGN_TOKENS.iconography.sizes[size];
  return (
    <Icon
      size={px}
      strokeWidth={DESIGN_TOKENS.iconography.strokeWidth}
      className={`shrink-0 ${className}`}
      aria-hidden={decorative && !label ? true : undefined}
      aria-label={label}
    />
  );
};

/* ---------------------------------------------------------------------------
   Status Badge (Standard 03 & 05: Never hue-only; paired with text/icon)
   --------------------------------------------------------------------------- */

export const StatusBadge: React.FC<{
  tone?: Tone;
  children: React.ReactNode;
  className?: string;
  showIcon?: boolean;
  icon?: React.ReactNode;
}> = ({ tone = 'neutral', children, className = '', showIcon = false, icon }) => {
  const ToneIcon = TONE_ICON[tone];
  return (
    <span className={`badge ${TONE_BADGE[tone]} ${className}`}>
      {icon ?? (showIcon && ToneIcon ? <ToneIcon className="h-3 w-3 shrink-0" strokeWidth={1.75} aria-hidden="true" /> : null)}
      <span>{children}</span>
    </span>
  );
};

/* ---------------------------------------------------------------------------
   Standardized Buttons & Form Controls (Standard 05 & 08)
   --------------------------------------------------------------------------- */

export type ButtonVariant = 'primary' | 'secondary' | 'emerald' | 'danger' | 'ghost';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  loadingLabel?: string;
  icon?: React.ReactNode;
  iconRight?: React.ReactNode;
}

const BUTTON_VARIANT_CLASS: Record<ButtonVariant, string> = {
  primary: 'btn-primary',
  secondary: 'btn-secondary',
  emerald: 'btn-emerald',
  danger: 'btn-danger',
  ghost: 'btn-ghost',
};

const BUTTON_SIZE_CLASS: Record<ButtonSize, string> = {
  sm: 'btn-sm',
  md: '',
  lg: 'btn-lg',
};

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      variant = 'primary',
      size = 'md',
      loading = false,
      loadingLabel,
      icon,
      iconRight,
      disabled,
      className = '',
      type = 'button',
      children,
      ...rest
    },
    ref
  ) => (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={`btn ${BUTTON_VARIANT_CLASS[variant]} ${BUTTON_SIZE_CLASS[size]} ${className}`}
      {...rest}
    >
      {loading ? (
        <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" strokeWidth={1.75} aria-hidden="true" />
      ) : (
        icon
      )}
      <span>{loading && loadingLabel ? loadingLabel : children}</span>
      {!loading && iconRight}
    </button>
  )
);
Button.displayName = 'Button';

export interface IconButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  variant?: 'secondary' | 'ghost' | 'danger';
  size?: 'sm' | 'md';
}

export const IconButton = React.forwardRef<HTMLButtonElement, IconButtonProps>(
  ({ label, variant = 'ghost', size = 'md', className = '', type = 'button', children, ...rest }, ref) => {
    const dim = size === 'sm' ? 'h-8 w-8' : 'h-9 w-9';
    const look =
      variant === 'secondary'
        ? 'border border-slate-200 bg-white text-slate-600 hover:border-slate-300 hover:bg-slate-50 hover:text-slate-900 dark:border-white/10 dark:bg-white/[0.04] dark:text-slate-300 dark:hover:bg-white/[0.08] dark:hover:text-white'
        : variant === 'danger'
        ? 'text-rose-600 hover:bg-rose-50 dark:text-rose-400 dark:hover:bg-rose-500/15'
        : 'text-slate-500 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-white/[0.08] dark:hover:text-white';
    return (
      <button
        ref={ref}
        type={type}
        aria-label={label}
        title={rest.title || label}
        className={`inline-flex ${dim} shrink-0 items-center justify-center rounded-lg transition-colors disabled:pointer-events-none disabled:opacity-50 ${look} ${className}`}
        {...rest}
      >
        {children}
      </button>
    );
  }
);
IconButton.displayName = 'IconButton';

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  mono?: boolean;
  invalid?: boolean;
}

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ mono = false, invalid, className = '', ...rest }, ref) => (
    <input
      ref={ref}
      aria-invalid={invalid || rest['aria-invalid']}
      className={`app-input ${mono ? 'app-input-mono' : ''} ${className}`}
      {...rest}
    />
  )
);
Input.displayName = 'Input';

export interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  invalid?: boolean;
}

export const Select = React.forwardRef<HTMLSelectElement, SelectProps>(
  ({ invalid, className = '', children, ...rest }, ref) => (
    <select
      ref={ref}
      aria-invalid={invalid || rest['aria-invalid']}
      className={`app-input ${className}`}
      {...rest}
    >
      {children}
    </select>
  )
);
Select.displayName = 'Select';

export interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  invalid?: boolean;
}

export const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ invalid, className = '', ...rest }, ref) => (
    <textarea
      ref={ref}
      aria-invalid={invalid || rest['aria-invalid']}
      className={`app-input ${className}`}
      {...rest}
    />
  )
);
Textarea.displayName = 'Textarea';

/* ---------------------------------------------------------------------------
   Accessible Tabs / Segmented Control (Standard 05 & 08)
   --------------------------------------------------------------------------- */

export interface TabOption<T extends string = string> {
  id: T;
  label: string;
  icon?: React.ReactNode;
  badge?: string | number;
  disabled?: boolean;
}

export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
  ariaLabel = 'Section tabs',
  className = '',
}: {
  tabs: ReadonlyArray<TabOption<T>>;
  value: T;
  onChange: (id: T) => void;
  ariaLabel?: string;
  className?: string;
}) {
  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className={`inline-flex flex-wrap items-center gap-1 rounded-lg border border-slate-200 bg-slate-100/80 p-1 dark:border-white/[0.08] dark:bg-white/[0.04] ${className}`}
    >
      {tabs.map(tab => {
        const selected = tab.id === value;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={selected}
            disabled={tab.disabled}
            onClick={() => onChange(tab.id)}
            className={`inline-flex min-h-[32px] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-3 py-1.5 text-[12px] font-semibold transition-colors disabled:pointer-events-none disabled:opacity-50 ${
              selected
                ? 'bg-white text-slate-900 shadow-xs dark:bg-slate-800 dark:text-white'
                : 'text-slate-600 hover:text-slate-900 dark:text-slate-300 dark:hover:text-white'
            }`}
          >
            {tab.icon}
            <span>{tab.label}</span>
            {tab.badge !== undefined && (
              <span
                className={`rounded px-1.5 py-0.5 font-mono text-[10px] font-bold tabular-nums ${
                  selected
                    ? 'bg-brand-50 text-brand-700 dark:bg-brand-500/20 dark:text-brand-300'
                    : 'bg-slate-200/80 text-slate-700 dark:bg-white/10 dark:text-slate-300'
                }`}
              >
                {tab.badge}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/* ---------------------------------------------------------------------------
   Page Chrome & Surfaces (Standards 01, 02, 04)
   --------------------------------------------------------------------------- */

export const PageShell: React.FC<{
  children: React.ReactNode;
  className?: string;
}> = ({ children, className = '' }) => (
  <div className={`mx-auto w-full max-w-7xl space-y-6 p-4 sm:p-6 ${className}`}>
    {children}
  </div>
);

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
          <span
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-600 ring-1 ring-brand-100 ring-inset dark:bg-brand-500/10 dark:text-brand-300 dark:ring-brand-500/20"
            aria-hidden="true"
          >
            {icon}
          </span>
        )}
        <h1 className="text-[22px] font-bold leading-tight tracking-tight text-slate-900 dark:text-white">
          {title}
        </h1>
      </div>
      {subtitle && (
        <p className="mt-1.5 max-w-3xl text-[13px] leading-relaxed text-slate-600 dark:text-slate-300">
          {subtitle}
        </p>
      )}
    </div>
    {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
  </div>
);

export const MetricTile: React.FC<{
  label: string;
  value: React.ReactNode;
  hint?: React.ReactNode;
  icon?: React.ReactNode;
  tone?: 'neutral' | 'blue' | 'emerald' | 'amber' | 'rose';
  compact?: boolean;
}> = ({ label, value, hint, icon, tone = 'neutral', compact = false }) => {
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
      ? 'bg-brand-50 text-brand-600 dark:bg-brand-500/15 dark:text-brand-300'
      : tone === 'emerald'
      ? 'bg-emerald-50 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-300'
      : tone === 'amber'
      ? 'bg-amber-50 text-amber-600 dark:bg-amber-500/15 dark:text-amber-300'
      : tone === 'rose'
      ? 'bg-rose-50 text-rose-600 dark:bg-rose-500/15 dark:text-rose-300'
      : 'bg-slate-100 text-slate-600 dark:bg-white/[0.08] dark:text-slate-300';

  return (
    <div className={`surface flex items-center justify-between gap-3 ${compact ? 'p-3.5' : 'p-4'}`}>
      <div className="min-w-0">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
          {label}
        </div>
        <div className={`mt-1 font-mono ${compact ? 'text-base' : 'text-xl'} font-bold tabular-nums ${valueTone}`}>
          {value}
        </div>
        {hint && (
          <div className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">{hint}</div>
        )}
      </div>
      {icon && (
        <div
          className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${iconTone}`}
          aria-hidden="true"
        >
          {icon}
        </div>
      )}
    </div>
  );
};

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
            <p className="mt-0.5 text-[12px] leading-relaxed text-slate-600 dark:text-slate-400">
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
  trend?: { direction: 'up' | 'down' | 'neutral'; value: string };
}> = ({ label, value, hint, icon, tone = 'neutral', loading, trend }) => {
  const valueTone =
    tone === 'blue'
      ? 'text-brand-700 dark:text-brand-300'
      : tone === 'emerald'
      ? 'text-emerald-700 dark:text-emerald-300'
      : tone === 'amber'
      ? 'text-amber-700 dark:text-amber-300'
      : tone === 'rose'
      ? 'text-rose-700 dark:text-rose-300'
      : 'text-slate-900 dark:text-white';

  const topRule =
    tone === 'blue'
      ? 'bg-brand-500/70'
      : tone === 'emerald'
      ? 'bg-emerald-500/70'
      : tone === 'amber'
      ? 'bg-amber-500/70'
      : tone === 'rose'
      ? 'bg-rose-500/70'
      : 'bg-slate-300/70 dark:bg-white/10';

  const iconTone =
    tone === 'blue'
      ? 'bg-brand-50 text-brand-700 dark:bg-brand-500/15 dark:text-brand-300'
      : tone === 'emerald'
      ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300'
      : tone === 'amber'
      ? 'bg-amber-50 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300'
      : tone === 'rose'
      ? 'bg-rose-50 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300'
      : 'bg-slate-100 text-slate-600 dark:bg-white/[0.08] dark:text-slate-300';

  const trendBadge =
    trend && trend.direction !== 'neutral'
      ? trend.direction === 'up'
        ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300'
        : 'bg-rose-50 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300'
      : 'bg-slate-100 text-slate-700 dark:bg-white/[0.08] dark:text-slate-300';

  return (
    <div className="surface surface-hover relative flex min-h-[124px] flex-col justify-between overflow-hidden p-5">
      <span className={`absolute inset-x-0 top-0 h-[2px] ${topRule}`} aria-hidden="true" />
      <div className="flex items-start justify-between gap-3">
        <span className="text-[13px] font-medium tracking-[-0.01em] text-slate-600 dark:text-slate-300">
          {label}
        </span>
        {icon && (
          <span
            className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${iconTone}`}
            aria-hidden="true"
          >
            {icon}
          </span>
        )}
      </div>
      {loading ? (
        <div className="skeleton mt-3 h-8 w-32" aria-label="Loading metric" />
      ) : (
        <div className={`mt-2 font-mono text-[26px] font-bold leading-none tracking-[-0.02em] tabular-nums ${valueTone}`}>
          {value}
        </div>
      )}
      {(hint || trend) && (
        <div className="mt-2.5 flex min-h-[18px] flex-wrap items-center gap-1.5 text-[11px] text-slate-600 dark:text-slate-400">
          {trend && trend.direction !== 'neutral' && (
            <span className={`inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[11px] font-semibold ${trendBadge}`}>
              {trend.direction === 'up' ? '▲' : '▼'} {trend.value}
            </span>
          )}
          {hint}
        </div>
      )}
    </div>
  );
};

/* ---------------------------------------------------------------------------
   UI States: Empty, Loading, Error, InlineAlert (Standard 09)
   --------------------------------------------------------------------------- */

export const EmptyState: React.FC<{
  title: string;
  description?: string;
  action?: React.ReactNode;
  icon?: React.ReactNode;
}> = ({ title, description, action, icon }) => (
  <div className="flex flex-col items-center justify-center px-4 py-12 text-center">
    <div
      className="mb-3.5 flex h-12 w-12 items-center justify-center rounded-xl bg-slate-100 text-slate-500 ring-1 ring-slate-200/80 ring-inset dark:bg-white/[0.06] dark:text-slate-400 dark:ring-white/[0.08]"
      aria-hidden="true"
    >
      {icon || <Inbox className="h-5 w-5" strokeWidth={1.75} />}
    </div>
    <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">{title}</div>
    {description && (
      <p className="mt-1.5 max-w-md text-[13px] leading-relaxed text-slate-600 dark:text-slate-400">
        {description}
      </p>
    )}
    {action && <div className="mt-4">{action}</div>}
  </div>
);

export const LoadingState: React.FC<{
  label?: string;
  rows?: number;
  className?: string;
}> = ({ label = 'Loading records…', rows = 4, className = '' }) => (
  <div role="status" aria-live="polite" className={`space-y-3 p-4 ${className}`}>
    <div className="flex items-center gap-2 text-xs font-medium text-slate-600 dark:text-slate-300">
      <Loader2 className="h-4 w-4 animate-spin text-brand-600 dark:text-brand-400" strokeWidth={1.75} aria-hidden="true" />
      <span>{label}</span>
    </div>
    <div className="space-y-2">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="skeleton h-9 w-full" />
      ))}
    </div>
  </div>
);

export const TableLoadingRows: React.FC<{ colSpan: number; rows?: number }> = ({
  colSpan,
  rows = 5,
}) => (
  <>
    {Array.from({ length: rows }).map((_, idx) => (
      <tr key={idx} aria-hidden="true">
        <td colSpan={colSpan} className="px-3 py-2.5">
          <div className="skeleton h-5 w-full" />
        </td>
      </tr>
    ))}
  </>
);

export const ErrorState: React.FC<{
  title?: string;
  message: string;
  onRetry?: () => void;
  retryLabel?: string;
}> = ({ title = 'Unable to load data', message, onRetry, retryLabel = 'Retry' }) => (
  <div
    role="alert"
    className="flex flex-col items-center justify-center rounded-lg border border-rose-200 bg-rose-50/70 px-4 py-10 text-center dark:border-rose-500/25 dark:bg-rose-500/10"
  >
    <div
      className="mb-3 flex h-11 w-11 items-center justify-center rounded-xl bg-rose-100 text-rose-700 dark:bg-rose-500/20 dark:text-rose-300"
      aria-hidden="true"
    >
      <AlertTriangle className="h-5 w-5" strokeWidth={1.75} />
    </div>
    <div className="text-sm font-semibold text-rose-900 dark:text-rose-100">{title}</div>
    <p className="mt-1 max-w-md text-[13px] leading-relaxed text-rose-800 dark:text-rose-200">
      {message}
    </p>
    {onRetry && (
      <div className="mt-4">
        <Button variant="secondary" size="sm" onClick={onRetry} icon={<RefreshCw className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />}>
          {retryLabel}
        </Button>
      </div>
    )}
  </div>
);

export const InlineAlert: React.FC<{
  tone?: 'error' | 'warning' | 'success' | 'info';
  children: React.ReactNode;
  onDismiss?: () => void;
  action?: React.ReactNode;
}> = ({ tone = 'info', children, onDismiss, action }) => {
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
      className={`flex items-start justify-between gap-3 rounded-lg border p-3.5 text-[13px] leading-relaxed ${styles}`}
    >
      <span className="flex items-start gap-2.5">
        <Icon className="mt-0.5 h-4 w-4 shrink-0" strokeWidth={1.75} aria-hidden="true" />
        <span className="min-w-0">{children}</span>
      </span>
      <span className="flex shrink-0 items-center gap-2">
        {action}
        {onDismiss && (
          <button
            type="button"
            onClick={onDismiss}
            className="rounded-md px-2 py-1 text-[11px] font-semibold underline underline-offset-2 opacity-80 transition-opacity hover:opacity-100"
          >
            Dismiss
          </button>
        )}
      </span>
    </div>
  );
};

export const DataTableShell: React.FC<{
  children: React.ReactNode;
  className?: string;
}> = ({ children, className = '' }) => (
  <div className={`overflow-x-auto ${className}`}>{children}</div>
);

/* ---------------------------------------------------------------------------
   Modal primitives — shared shell, header, footer, multi-column body, field
   --------------------------------------------------------------------------- */

interface ModalShellProps {
  open: boolean;
  onClose: () => void;
  titleId?: string;
  size?: 'sm' | 'md' | 'lg' | 'xl' | '2xl' | '3xl' | '4xl';
  children: React.ReactNode;
  className?: string;
  /**
   * Optional guard consulted before the modal closes via Escape, overlay click
   * or the close button. Return `false` (or Promise<false>) to keep the modal
   * open (e.g. to prompt before discarding unsaved input).
   */
  beforeClose?: () => boolean | Promise<boolean>;
}

export const ModalShell: React.FC<ModalShellProps> = ({
  open,
  onClose,
  titleId,
  size = 'lg',
  children,
  className = '',
  beforeClose,
}) => {
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const beforeCloseRef = useRef(beforeClose);
  beforeCloseRef.current = beforeClose;
  const requestCloseRef = useRef<() => Promise<void>>(async () => onClose());
  requestCloseRef.current = async () => {
    if (beforeCloseRef.current) {
      const ok = await beforeCloseRef.current();
      if (!ok) return;
    }
    onClose();
  };

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
    const t = window.setTimeout(() => {
      const focusable = panelRef.current?.querySelector<HTMLElement>(
        'input, select, textarea, button, [tabindex]:not([tabindex="-1"])',
      );
      (focusable || panelRef.current)?.focus();
    }, 50);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        void requestCloseRef.current();
      }
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
        if (e.target === e.currentTarget) void requestCloseRef.current();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={`animate-modal-enter relative flex max-h-[92vh] w-full ${widthClass[size]} flex-col overflow-hidden rounded-2xl border border-slate-200/80 bg-[#fcfcfd] shadow-2xl outline-none dark:border-white/[0.08] dark:bg-slate-900 ${className}`}
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
  /** Id applied to the title, matching the dialog's aria-labelledby. */
  titleId?: string;
}

export const ModalHeader: React.FC<ModalHeaderProps> = ({
  title,
  subtitle,
  icon,
  tone = 'brand',
  onClose,
  titleId,
}) => {
  const toneClass: Record<string, string> = {
    brand: 'bg-brand-50 text-brand-600 ring-brand-100 dark:bg-brand-500/10 dark:text-brand-300 dark:ring-brand-500/20',
    emerald: 'bg-emerald-50 text-emerald-600 ring-emerald-100 dark:bg-emerald-500/10 dark:text-emerald-300 dark:ring-emerald-500/20',
    amber: 'bg-amber-50 text-amber-600 ring-amber-100 dark:bg-amber-500/10 dark:text-amber-300 dark:ring-amber-500/20',
    rose: 'bg-rose-50 text-rose-600 ring-rose-100 dark:bg-rose-500/10 dark:text-rose-300 dark:ring-rose-500/20',
    slate: 'bg-slate-100 text-slate-600 ring-slate-200 dark:bg-white/[0.06] dark:text-slate-300 dark:ring-white/10',
  };
  return (
    <div className="flex shrink-0 items-start justify-between gap-3 border-b border-slate-200/80 bg-white px-5 py-4 dark:border-white/[0.06] dark:bg-slate-900">
      <div className="flex min-w-0 items-start gap-3">
        {icon && (
          <span
            className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ring-1 ring-inset ${toneClass[tone]}`}
            aria-hidden="true"
          >
            {icon}
          </span>
        )}
        <div className="min-w-0">
          <h2 id={titleId} className="truncate text-[19px] font-semibold leading-tight tracking-tight text-slate-900 dark:text-white">
            {title}
          </h2>
          {subtitle && (
            <p className="mt-0.5 text-[12px] leading-relaxed text-slate-600 dark:text-slate-400">
              {subtitle}
            </p>
          )}
        </div>
      </div>
      <button
        type="button"
        onClick={onClose}
        aria-label="Close dialog"
        className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-800 dark:text-slate-400 dark:hover:bg-white/10 dark:hover:text-white"
      >
        <X className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
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
    rose: 'btn bg-rose-600 text-white hover:bg-rose-700',
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
          aria-busy={busy || undefined}
          className={submitClass[tone]}
        >
          {busy ? (
            <>
              <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.75} aria-hidden="true" />
              Saving…
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
  <section className={aside ? `surface p-4 ${className}` : `space-y-3 ${className}`}>
    {title && (
      <h3
        className={`flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-[0.08em] text-slate-600 dark:text-slate-300 ${
          aside ? 'mb-2.5' : ''
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
}) => {
  const generatedId = React.useId();
  const hintId = `${generatedId}-hint`;
  const describedBy = error || hint ? hintId : undefined;

  type ControlProps = {
    id?: string;
    'aria-describedby'?: string;
    'aria-invalid'?: boolean;
  };
  const child = React.isValidElement(children)
    ? (children as React.ReactElement<ControlProps>)
    : null;
  const controlId = child?.props.id ?? generatedId;
  const control = child
    ? React.cloneElement(child, {
        id: controlId,
        'aria-describedby': describedBy,
        ...(error ? { 'aria-invalid': true } : {}),
      })
    : children;

  return (
    <div className={className}>
      <label htmlFor={controlId} className="app-label">
        {label}
        {required && <span className="ml-0.5 text-rose-600">*</span>}
      </label>
      {control}
      {error ? (
        <p id={hintId} className="mt-1 text-[11px] font-medium text-rose-600 dark:text-rose-400">
          {error}
        </p>
      ) : hint ? (
        <p id={hintId} className="mt-1 text-[11px] text-slate-600 dark:text-slate-400">
          {hint}
        </p>
      ) : null}
    </div>
  );
};

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
    neutral: emphasis ? 'text-slate-900 dark:text-white' : 'text-slate-700 dark:text-slate-300',
    emerald: 'text-emerald-700 dark:text-emerald-400',
    rose: 'text-rose-700 dark:text-rose-400',
    brand: 'text-brand-700 dark:text-brand-400',
    amber: 'text-amber-700 dark:text-amber-400',
  };
  return (
    <div className={`flex items-center justify-between gap-2 py-1 ${emphasis ? 'border-t border-slate-200/70 pt-2 dark:border-white/[0.06]' : ''}`}>
      <span className="text-[12px] text-slate-600 dark:text-slate-400">{label}</span>
      <span className={`font-mono text-[13px] font-semibold tabular-nums ${valueClass[tone]}`}>{value}</span>
    </div>
  );
};
