import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, ClipboardList, Plus, Send, Trash2 } from 'lucide-react';
import { commercialApi } from '../../services/commercialApi';
import { formatCurrency } from '../../utils/currency';
import { FormField, FormSection, ModalBody, ModalFooter, ModalHeader, ModalShell, SummaryRow } from '../common/ui';

/**
 * Physical stock count.
 *
 * Two-step by design: `createStockCount` writes a draft and never touches
 * stock, so the warehouse can key figures in without disturbing live
 * quantities. Only `postStockCount` applies the variances and raises the
 * journal. The draft lines carry `systemQty` captured at creation time, and the
 * server re-reads the live on-hand when posting, so a count started yesterday
 * still posts against today's actual stock.
 */

export interface StockCountModalProps {
  open: boolean;
  items: Array<{
    id: string | number;
    sku: string;
    name: string;
    onHand: number;
    usageUnit?: string;
    avgCost?: number;
  }>;
  /** Optional item id to pre-fill the first line. */
  initialItemId?: string | number | null;
  onClose: () => void;
  onSuccess: (message: string) => void;
}

interface LineState {
  key: string;
  itemId: string;
  countedQty: string;
}

let seq = 0;
const newLine = (itemId = ''): LineState => ({ key: `c${++seq}`, itemId, countedQty: '' });

export const StockCountModal: React.FC<StockCountModalProps> = ({
  open,
  items,
  initialItemId,
  onClose,
  onSuccess,
}) => {
  const [countDate, setCountDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<LineState[]>([newLine()]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setCountDate(new Date().toISOString().slice(0, 10));
    setNotes('');
    setLines([newLine(initialItemId != null ? String(initialItemId) : '')]);
    setError(null);
    setSubmitting(false);
  }, [open, initialItemId]);

  const itemById = useMemo(() => new Map(items.map(i => [String(i.id), i])), [items]);

  if (!open) return null;

  const activeLines = lines.filter(l => l.itemId);

  const preview = activeLines.map(line => {
    const item = itemById.get(line.itemId);
    const systemQty = Number(item?.onHand) || 0;
    const countedQty = line.countedQty.trim() === '' ? systemQty : Number(line.countedQty) || 0;
    const unitCost = Number(item?.avgCost) || 0;
    return {
      ...line,
      systemQty,
      countedQty,
      varianceQty: countedQty - systemQty,
      varianceValue: (countedQty - systemQty) * unitCost,
      usageUnit: item?.usageUnit,
    };
  });

  const netValue = preview.reduce((sum, p) => sum + p.varianceValue, 0);
  const changed = preview.filter(p => p.varianceQty !== 0).length;

  const update = (key: string, patch: Partial<LineState>) => {
    setLines(prev => prev.map(l => (l.key === key ? { ...l, ...patch } : l)));
  };

  const create = async () => {
    if (submitting) return;
    if (activeLines.length === 0) {
      setError('Add at least one item to count.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const result = await commercialApi.createStockCount({
        countDate,
        notes: notes.trim() || null,
        lines: activeLines.map(l => ({
          itemId: Number(l.itemId),
          countedQty: l.countedQty.trim() === '' ? String(itemById.get(l.itemId)?.onHand ?? 0) : String(Number(l.countedQty)),
        })),
      });

      // Posting is a separate, explicit step so the operator can review the
      // variance the server computed before it hits the ledger.
      const posted = await commercialApi.postStockCount(result.countId, {
        notes: notes.trim() || null,
      });

      onSuccess(
        `Count ${posted.countNumber} posted · ${posted.lines.length} line${posted.lines.length === 1 ? '' : 's'} · net variance ${formatCurrency(Number(posted.netVariance))}${
          posted.entryNumber ? ` · ${posted.entryNumber}` : ' · no journal required'
        }`
      );
      onClose();
    } catch (err: any) {
      setError(err?.message || 'Failed to create or post the stock count.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <ModalShell open={open} onClose={onClose} titleId="stock-count-modal-title" size="3xl">
      <ModalHeader
        title="Physical Stock Count"
        subtitle="Count stock, then post the variances to the ledger"
        tone="amber"
        icon={<ClipboardList className="h-4 w-4" />}
        onClose={onClose}
      />
      <form
        id="stock-count-form"
        onSubmit={e => {
          e.preventDefault();
          create();
        }}
        className="flex min-h-0 flex-1 flex-col"
      >
        <ModalBody columns={2}>
          <FormSection title="Count details">
            <FormField label="Count date" required>
              <input
                type="date"
                value={countDate}
                onChange={e => setCountDate(e.target.value)}
                className="app-input font-mono"
              />
            </FormField>
            <FormField label="Notes">
              <textarea
                value={notes}
                onChange={e => setNotes(e.target.value)}
                rows={3}
                placeholder="Area counted, counter names, etc."
                className="app-input resize-y"
              />
            </FormField>
            <div className="surface p-4">
              <SummaryRow label="Items counted" value={activeLines.length} />
              <SummaryRow label="With variance" value={changed} tone={changed > 0 ? 'amber' : 'neutral'} />
              <SummaryRow
                label="Net variance value"
                value={formatCurrency(netValue)}
                emphasis
                tone={netValue < 0 ? 'rose' : netValue > 0 ? 'emerald' : 'neutral'}
              />
            </div>
          </FormSection>

          <FormSection title="Counted quantities">
            <div className="space-y-2">
              {lines.map(line => {
                const row = preview.find(p => p.key === line.key);
                return (
                  <div key={line.key} className="surface space-y-2 p-3">
                    <div className="flex items-start gap-2">
                      <select
                        value={line.itemId}
                        onChange={e => update(line.key, { itemId: e.target.value })}
                        className="app-input min-w-0 flex-1"
                        aria-label="Item"
                      >
                        <option value="">Select item…</option>
                        {items.map(i => (
                          <option key={i.id} value={i.id}>
                            {i.sku} — {i.name} ({i.onHand} {i.usageUnit || 'on hand'})
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        onClick={() =>
                          setLines(prev => (prev.length === 1 ? prev : prev.filter(l => l.key !== line.key)))
                        }
                        disabled={lines.length === 1}
                        aria-label="Remove line"
                        className="rounded-lg p-1.5 text-slate-400 transition hover:bg-rose-50 hover:text-rose-600 disabled:opacity-40 dark:hover:bg-rose-500/10"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>

                    {row && (
                      <>
                        <div className="flex items-center gap-2">
                          <input
                            type="number"
                            min="0"
                            step="0.0001"
                            value={line.countedQty}
                            onChange={e => update(line.key, { countedQty: e.target.value })}
                            placeholder={String(row.systemQty)}
                            aria-label={`Counted quantity for ${line.itemId}`}
                            className="app-input w-full font-mono"
                          />
                          <button
                            type="button"
                            onClick={() => update(line.key, { countedQty: String(row.systemQty) })}
                            className="shrink-0 rounded-lg bg-slate-100 px-2 py-1.5 text-[10px] font-semibold text-slate-600 transition hover:bg-slate-200 dark:bg-white/10 dark:text-slate-300 dark:hover:bg-white/15"
                          >
                            Match system
                          </button>
                        </div>
                        <div className="flex items-center justify-between gap-2 text-[10px]">
                          <span className="text-slate-400">System {row.systemQty}</span>
                          <span
                            className={`font-mono font-bold ${
                              row.varianceQty === 0
                                ? 'text-slate-400'
                                : row.varianceQty > 0
                                ? 'text-emerald-600 dark:text-emerald-400'
                                : 'text-rose-600 dark:text-rose-400'
                            }`}
                          >
                            {row.varianceQty > 0 ? '+' : ''}
                            {row.varianceQty} ({formatCurrency(row.varianceValue)})
                          </span>
                        </div>
                      </>
                    )}
                  </div>
                );
              })}
            </div>
            <button
              type="button"
              onClick={() => setLines(prev => [...prev, newLine()])}
              className="btn-secondary inline-flex items-center gap-1.5 px-3 py-1.5 text-[11px]"
            >
              <Plus className="h-3.5 w-3.5" />
              Add line
            </button>
          </FormSection>

          <div className="lg:col-span-2">
            <SummaryRow
              label="Posting"
              value="Creates a draft, then posts variances to stock and the general ledger"
            />
          </div>

          {error && (
            <div className="flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 p-3 text-xs text-rose-700 lg:col-span-2 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-300">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}
        </ModalBody>
        <ModalFooter
          onCancel={onClose}
          tone="brand"
          submitLabel="Create & Post Count"
          submitIcon={<Send className="h-3.5 w-3.5" />}
          busy={submitting}
          disabled={activeLines.length === 0}
        />
      </form>
    </ModalShell>
  );
};

export default StockCountModal;