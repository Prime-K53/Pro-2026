import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useExamGroupSelection } from './useExamGroupSelection';

const { mockGetForBatch } = vi.hoisted(() => ({ mockGetForBatch: vi.fn() }));

vi.mock('../context/AccountingContext', () => ({
  useAccounting: () => ({ getExamGroupForBatch: mockGetForBatch }),
}));

const group = (over: Partial<any> = {}) => ({
  batchId: 10,
  examBatchGroupId: 1,
  groupReference: 'ref-1',
  schoolCustomerId: 5,
  assessmentName: 'Term 2 Exams',
  status: 'prepared',
  ...over,
});

describe('useExamGroupSelection (batch-driven)', () => {
  beforeEach(() => {
    mockGetForBatch.mockReset();
  });

  it('resolves the group from the selected batch', async () => {
    mockGetForBatch.mockResolvedValue(group());
    const { result } = renderHook(() => useExamGroupSelection(10));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.group?.examBatchGroupId).toBe(1);
    expect(mockGetForBatch).toHaveBeenCalledWith(10);
  });

  it('invalidates the previous group immediately when the batch changes', async () => {
    mockGetForBatch.mockResolvedValue(group({ batchId: 10, examBatchGroupId: 1 }));
    const { result, rerender } = renderHook(({ id }) => useExamGroupSelection(id), {
      initialProps: { id: 10 as number | null },
    });
    await waitFor(() => expect(result.current.group?.examBatchGroupId).toBe(1));

    // New batch resolves a different group; the old group must never leak.
    mockGetForBatch.mockResolvedValue(group({ batchId: 20, examBatchGroupId: 2 }));
    rerender({ id: 20 });
    await waitFor(() => expect(result.current.group?.examBatchGroupId).toBe(2));
    expect(result.current.group?.batchId).toBe(20);
  });

  it('does not expose a group that belongs to a different batch (stale guard)', async () => {
    mockGetForBatch.mockResolvedValue(group({ batchId: 10, examBatchGroupId: 1 }));
    const { result, rerender } = renderHook(({ id }) => useExamGroupSelection(id), {
      initialProps: { id: 10 as number | null },
    });
    await waitFor(() => expect(result.current.group?.examBatchGroupId).toBe(1));
    // Switch to a batch with no resolution yet; the previous group must be gone.
    mockGetForBatch.mockReturnValue(new Promise(() => {}));
    rerender({ id: 99 });
    expect(result.current.group).toBeNull();
  });

  it('is empty when no batch is selected', async () => {
    const { result } = renderHook(() => useExamGroupSelection(null));
    await waitFor(() => expect(result.current.status).toBe('empty'));
    expect(result.current.group).toBeNull();
    expect(mockGetForBatch).not.toHaveBeenCalled();
  });

  it('fails closed on a lookup error', async () => {
    mockGetForBatch.mockRejectedValue(new Error('EXAM_BATCH_GROUP_MISSING'));
    const { result } = renderHook(() => useExamGroupSelection(10));
    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.group).toBeNull();
  });
});