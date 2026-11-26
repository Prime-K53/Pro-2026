import React, {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from 'react';

/**
 * TransactionSelectionProvider
 * -----------------------------------------------------------------------------
 * Framework-level multi-selection, fully independent of any module's own
 * selection state (e.g. Examination paper selection, reconciliation clearing).
 *
 * Supports:
 *  - per-row toggle
 *  - select-all-visible
 *  - shift-click range selection (needs the ordered visible ids)
 *  - clear
 */

export type SelectionId = string | number;

interface TransactionSelectionContextValue {
  selectedIds: SelectionId[];
  selectedSet: ReadonlySet<SelectionId>;
  isSelected: (id: SelectionId) => boolean;
  toggle: (id: SelectionId, options?: { shiftKey?: boolean }) => void;
  selectAll: (ids: SelectionId[]) => void;
  clear: () => void;
  /** Register the current ordered visible ids (for shift-range). */
  setOrderedIds: (ids: SelectionId[]) => void;
}

const TransactionSelectionContext = createContext<TransactionSelectionContextValue | null>(
  null
);

export const TransactionSelectionProvider: React.FC<{
  children: React.ReactNode;
  /** Optional controlled initial selection. */
  initialSelected?: SelectionId[];
}> = ({ children, initialSelected }) => {
  const [selected, setSelected] = useState<Set<SelectionId>>(
    () => new Set(initialSelected ?? [])
  );
  const orderedRef = useRef<SelectionId[]>([]);
  const anchorRef = useRef<SelectionId | null>(null);

  const setOrderedIds = useCallback((ids: SelectionId[]) => {
    orderedRef.current = ids;
  }, []);

  const toggle = useCallback((id: SelectionId, options?: { shiftKey?: boolean }) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (options?.shiftKey && anchorRef.current !== null) {
        const ordered = orderedRef.current;
        const a = ordered.indexOf(anchorRef.current);
        const b = ordered.indexOf(id);
        if (a >= 0 && b >= 0) {
          const [start, end] = a <= b ? [a, b] : [b, a];
          for (let i = start; i <= end; i += 1) next.add(ordered[i]);
          return next;
        }
      }
      if (next.has(id)) {
        next.delete(id);
        anchorRef.current = null;
      } else {
        next.add(id);
        anchorRef.current = id;
      }
      return next;
    });
  }, []);

  const selectAll = useCallback((ids: SelectionId[]) => {
    setSelected(new Set(ids));
    anchorRef.current = ids.length > 0 ? ids[0] : null;
  }, []);

  const clear = useCallback(() => {
    setSelected(new Set());
    anchorRef.current = null;
  }, []);

  const value = useMemo<TransactionSelectionContextValue>(() => {
    const selectedSet = selected;
    return {
      selectedIds: Array.from(selected),
      selectedSet,
      isSelected: (id) => selectedSet.has(id),
      toggle,
      selectAll,
      clear,
      setOrderedIds,
    };
  }, [selected, toggle, selectAll, clear, setOrderedIds]);

  return (
    <TransactionSelectionContext.Provider value={value}>
      {children}
    </TransactionSelectionContext.Provider>
  );
};

export function useTransactionSelection(): TransactionSelectionContextValue {
  const ctx = useContext(TransactionSelectionContext);
  if (!ctx) {
    throw new Error(
      'useTransactionSelection must be used within a TransactionSelectionProvider'
    );
  }
  return ctx;
}