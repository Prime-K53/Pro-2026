import { useEffect, useState } from 'react';
import { useAccounting } from '../context/AccountingContext';

export interface ResolvedExamGroup {
  batchId: number;
  examBatchGroupId: number;
  groupReference: string;
  schoolCustomerId: number;
  assessmentName: string;
  status: string;
}

export type ExamGroupSelectionStatus = 'empty' | 'loading' | 'error' | 'ready';

/**
 * Resolves the examination group from the *selected examination batch's*
 * persisted `exam_batch_group_id` (server-authoritative). A group is never
 * inferred from the school or from a "most recent" id, and the previous group
 * is invalidated immediately when the selected batch changes. Any missing or
 * inconsistent relationship fails closed with no fallback.
 */
export function useExamGroupSelection(batchId: number | null) {
  const { getExamGroupForBatch } = useAccounting();
  const [group, setGroup] = useState<ResolvedExamGroup | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Invalidate the previous resolution immediately; never retain it while
    // loading or after a failed lookup.
    setGroup(null);
    setError(null);
    if (batchId == null || !Number.isInteger(batchId)) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const g = await getExamGroupForBatch(batchId);
        if (!cancelled) setGroup(g as ResolvedExamGroup);
      } catch (e: any) {
        if (!cancelled) setError(e?.message || 'Failed to resolve the examination group');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [batchId]);

  // Guard against any stale render: only expose a group that belongs to the
  // currently selected batch.
  const activeGroup = group && group.batchId === batchId ? group : null;
  const status: ExamGroupSelectionStatus = loading
    ? 'loading'
    : error
    ? 'error'
    : activeGroup
    ? 'ready'
    : 'empty';

  return { group: activeGroup, loading, error, status };
}