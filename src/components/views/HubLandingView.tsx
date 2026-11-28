import React from 'react';
import { ArrowLeft } from 'lucide-react';
import { Button, PageHeader, PageShell } from '../common/ui';

/**
 * Reusable hub landing component aligned with Prime Printing ERP Design System
 * tokens (Plus Jakarta Sans + JetBrains Mono, brand-600 accents, .surface cards).
 */
export interface HubCard {
  id: string;
  label: string;
  description: string;
  icon: React.ElementType;
  count?: number;
}

export interface HubLandingViewProps {
  title: string;
  titleAccent?: string;
  subtitle: string;
  cards: HubCard[];
  activeId: string | null;
  onOpen: (id: string) => void;
  onBack: () => void;
  headerActions?: React.ReactNode;
  landingExtra?: React.ReactNode;
  children: React.ReactNode;
}

export const HubLandingView: React.FC<HubLandingViewProps> = ({
  title,
  titleAccent,
  subtitle,
  cards,
  activeId,
  onOpen,
  onBack,
  headerActions,
  landingExtra,
  children,
}) => {
  const isOpen = activeId !== null;
  const activeLabel = cards.find(card => card.id === activeId)?.label;
  const fullTitle = titleAccent ? `${title} ${titleAccent}` : title;

  return (
    <PageShell>
      {!isOpen && (
        <>
          <PageHeader title={fullTitle} subtitle={subtitle} actions={headerActions} />

          {landingExtra}

          <div
            className="grid gap-4"
            style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(min(220px, 100%), 1fr))' }}
          >
            {cards.map(card => {
              const Icon = card.icon;
              return (
                <button
                  key={card.id}
                  type="button"
                  onClick={() => onOpen(card.id)}
                  className="surface surface-hover group flex w-full flex-col items-start gap-3 p-5 text-left transition-all"
                >
                  <div className="flex w-full items-center justify-between gap-2">
                    <span
                      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-600 dark:bg-brand-500/10 dark:text-brand-400"
                      aria-hidden="true"
                    >
                      <Icon className="h-4.5 w-4.5" strokeWidth={1.75} />
                    </span>
                    {card.count !== undefined && (
                      <span className="rounded-md bg-slate-100 px-2 py-0.5 font-mono text-[11px] font-semibold tabular-nums text-slate-600 dark:bg-white/[0.06] dark:text-slate-300">
                        {card.count}
                      </span>
                    )}
                  </div>
                  <div className="space-y-1">
                    <div className="text-[14px] font-semibold text-slate-900 group-hover:text-brand-600 dark:text-white dark:group-hover:text-brand-400">
                      {card.label}
                    </div>
                    <p className="text-[12px] leading-relaxed text-slate-500 dark:text-slate-400">
                      {card.description}
                    </p>
                  </div>
                </button>
              );
            })}
          </div>
        </>
      )}

      {isOpen && (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <Button variant="secondary" size="sm" onClick={onBack}>
              <ArrowLeft className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
              <span>{title}</span>
            </Button>
            <span className="text-sm font-semibold text-slate-900 dark:text-white">{activeLabel}</span>
          </div>
          {children}
        </>
      )}
    </PageShell>
  );
};

export default HubLandingView;
