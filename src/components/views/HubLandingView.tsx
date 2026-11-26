import React from 'react';

/**
 * Reusable "Sales Flow"-style hub landing, ported from the PrimeERP GenericHub
 * design. Renders a centered serif gradient title, optional quick-action
 * buttons, a responsive card grid, and the "Operational Neural Link" footer.
 *
 * When a card is opened (`activeId` is set) the header + cards are hidden and
 * only a back bar + the active section label + `children` are shown. This keeps
 * each module's existing content/logic untouched — the hub only controls the
 * surrounding presentation.
 */
export interface HubCard {
  id: string;
  label: string;
  description: string;
  icon: React.ElementType;
  count?: number;
}

export interface HubLandingViewProps {
  /** Leading word of the title, e.g. "Sales". */
  title: string;
  /** Trailing accented word, e.g. "Command". Defaults to "Command". */
  titleAccent?: string;
  subtitle: string;
  cards: HubCard[];
  /** Currently open section id, or null to show the landing grid. */
  activeId: string | null;
  onOpen: (id: string) => void;
  onBack: () => void;
  /** Quick-action buttons shown on the landing header only. */
  headerActions?: React.ReactNode;
  /** Optional summary strip shown on the landing only (e.g. aging totals). */
  landingExtra?: React.ReactNode;
  /** Content rendered when a section is open. */
  children: React.ReactNode;
}

export const HubLandingView: React.FC<HubLandingViewProps> = ({
  title,
  titleAccent = 'Command',
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

  return (
    <div
      className="min-h-full bg-[#FEFDFB] px-5 py-10 text-[#23282A] dark:bg-[#070b14] dark:text-slate-100"
      style={{ fontFamily: "'Inter', 'Plus Jakarta Sans', sans-serif" }}
    >
      <div className="mx-auto flex w-full max-w-[1200px] flex-col gap-6">
        {!isOpen && (
          <>
            <div className="relative mx-auto mb-2 flex w-full flex-col items-center pt-3.5 text-center">
              <div className="absolute left-1/2 top-0 h-1 w-[120px] -translate-x-1/2 rounded-full bg-gradient-to-r from-[#0f766e] via-[#3fa294] to-[#f59e0b]" />
              <h1
                className="mb-2 bg-gradient-to-br from-[#0f544c] to-[#3fa294] bg-clip-text text-[28px] font-normal tracking-[0.2px] text-transparent sm:text-[36px] dark:from-[#8be0d3] dark:to-[#3fa294]"
                style={{ fontFamily: "'DM Serif Display', Georgia, serif" }}
              >
                {title}{' '}
                <span className="bg-gradient-to-br from-[#0f544c] to-[#2eb12e] bg-clip-text text-transparent dark:from-[#8be0d3] dark:to-[#2eb12e]">
                  {titleAccent}
                </span>
              </h1>
              <p className="mx-auto max-w-[520px] text-[13.5px] font-medium leading-relaxed text-[#5c6567] dark:text-slate-400">
                {subtitle}
              </p>
              {headerActions && (
                <div className="mt-5 flex flex-wrap items-center justify-center gap-2">{headerActions}</div>
              )}
            </div>

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
                    className="group relative flex w-full flex-col items-center justify-center gap-3.5 rounded-[14px] border border-[#e4ddd1] bg-[#FEFDFB] px-5 py-6 text-center transition-all duration-200 hover:-translate-y-0.5 hover:border-[#3fa294] hover:shadow-[0_4px_12px_rgba(31,133,119,0.1)] dark:border-white/10 dark:bg-slate-900/60"
                  >
                    <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-[#1f8577] to-[#0f544c] shadow-[0_4px_10px_-3px_rgba(31,133,119,0.4)]">
                      <Icon className="h-[22px] w-[22px] text-white" />
                    </span>
                    <span className="flex flex-col gap-1.5">
                      <span className="flex items-center justify-center gap-2">
                        <span className="m-0 text-base font-bold tracking-[0.01em] text-[#0f544c] dark:text-[#8be0d3]">
                          {card.label}
                        </span>
                        {card.count !== undefined && (
                          <span
                            className={`min-w-5 rounded-full px-2 py-[1px] text-center text-[10px] font-extrabold leading-[18px] ${
                              card.count > 0
                                ? 'bg-[#dc2626] text-white'
                                : 'bg-[#e4ddd1] text-[#5c6567] dark:bg-white/10 dark:text-slate-400'
                            }`}
                          >
                            {card.count}
                          </span>
                        )}
                      </span>
                      <span className="m-0 text-[11px] leading-relaxed text-[#5c6567] dark:text-slate-400">
                        {card.description}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          </>
        )}

        {isOpen && (
          <>
            <div className="flex items-center justify-between gap-3">
              <button
                type="button"
                onClick={onBack}
                className="flex items-center gap-1.5 rounded-lg border border-[#e4ddd1] bg-white/80 px-3.5 py-2 text-xs font-semibold text-[#0f544c] transition-colors hover:border-[#3fa294] hover:bg-white dark:border-white/10 dark:bg-slate-900/60 dark:text-[#8be0d3] dark:hover:bg-slate-900"
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  className="h-3.5 w-3.5"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <line x1="19" y1="12" x2="5" y2="12" />
                  <polyline points="12 19 5 12 12 5" />
                </svg>
                <span>{title}</span>
              </button>
              <span className="text-sm font-bold text-[#0f544c] dark:text-[#8be0d3]">{activeLabel}</span>
            </div>
            {children}
          </>
        )}

        <div className="mt-2 flex items-center justify-center gap-3.5 pb-2">
          <div className="h-px w-10 bg-[#e4ddd1] dark:bg-white/10" />
          <span className="text-[9px] font-extrabold uppercase tracking-[0.3px] text-[#5c6567] dark:text-slate-400">
            Operational Neural Link
          </span>
          <div className="h-px w-10 bg-[#e4ddd1] dark:bg-white/10" />
        </div>
      </div>
    </div>
  );
};

export default HubLandingView;