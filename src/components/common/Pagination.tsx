import { ChevronLeft, ChevronRight } from 'lucide-react';
import React from 'react';

export interface PaginationProps {
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (page: number) => void;
  onPageSizeChange?: (pageSize: number) => void;
  pageSizeOptions?: number[];
  /** Noun used in the "showing X–Y of Z" label. */
  label?: string;
}

/**
 * Client-side pagination control.
 *
 * The lists in this app are already fully loaded from the API, so paging is
 * applied over the in-memory array. It exists so that a large A/R, A/P or
 * journal register does not render thousands of DOM rows at once.
 */
export const Pagination: React.FC<PaginationProps> = ({
  page,
  pageSize,
  total,
  onPageChange,
  onPageSizeChange,
  pageSizeOptions = [25, 50, 100, 250],
  label = 'records',
}) => {
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(Math.max(1, page), pageCount);
  const first = total === 0 ? 0 : (safePage - 1) * pageSize + 1;
  const last = Math.min(total, safePage * pageSize);

  if (total === 0) return null;

  return (
    <nav
      aria-label="Pagination"
      className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 px-4 py-3 text-[12px] text-slate-600 dark:border-white/[0.08] dark:text-slate-300"
    >
      <span className="font-mono tabular-nums">
        Showing {first}–{last} of {total} {label}
      </span>

      <div className="flex flex-wrap items-center gap-3">
        {onPageSizeChange && (
          <label className="flex items-center gap-2">
            <span>Rows</span>
            <select
              value={pageSize}
              onChange={e => onPageSizeChange(Number(e.target.value))}
              className="min-h-[32px] rounded-lg border border-slate-300 bg-white px-2 py-1 font-mono text-[12px] text-slate-800 dark:border-white/15 dark:bg-slate-900 dark:text-slate-100"
              aria-label="Rows per page"
            >
              {pageSizeOptions.map(size => (
                <option key={size} value={size}>
                  {size}
                </option>
              ))}
            </select>
          </label>
        )}

        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => onPageChange(safePage - 1)}
            disabled={safePage <= 1}
            className="btn btn-secondary btn-sm"
            aria-label="Previous page"
          >
            <ChevronLeft className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
            <span>Prev</span>
          </button>
          <span className="px-2 font-mono text-[12px] font-semibold tabular-nums">
            {safePage} / {pageCount}
          </span>
          <button
            type="button"
            onClick={() => onPageChange(safePage + 1)}
            disabled={safePage >= pageCount}
            className="btn btn-secondary btn-sm"
            aria-label="Next page"
          >
            <span>Next</span>
            <ChevronRight className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
          </button>
        </div>
      </div>
    </nav>
  );
};

/** Slice helper: returns the rows for the given page. */
export function pageSlice<T>(rows: T[], page: number, pageSize: number): T[] {
  const safePage = Math.max(1, page);
  const start = (safePage - 1) * pageSize;
  return rows.slice(start, start + pageSize);
}