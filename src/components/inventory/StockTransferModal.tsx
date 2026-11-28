import { useEffect, useState } from 'react';
import { AlertTriangle, ArrowRightLeft, Plus, Trash2 } from 'lucide-react';
import { commercialApi } from '../../services/commercialApi';
import { formatCurrency } from '../../utils/currency';
import { FormField, FormSection, ModalBody, ModalFooter, ModalHeader, ModalShell, SummaryRow } from '../common/ui';

/**
 * Internal stock transfer between storage locations.
 *
 * A transfer is stock-neutral for the company and GL-neutral: it only moves the
 * per-location breakdown and writes two mirrored movement rows. The server
 * re-validates every line against the source location, so an over-transfer is
 * rejected even if the operator typed a larger figure than is actually there.
 */

export interface StockTransferModalProps {
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
  quantity: string;
  lotId: string;
  lotSearch: string;
}

let lineSeq = 0;
const newLine = (itemId = ''): LineState => ({
  key: `l${++lineSeq}`,
  itemId,
  quantity: '',
  lotId: '',
  lotSearch: '',
});

export const StockTransferModal: React.FC<StockTransferModalProps> = ({
  open,
  items,
  initialItemId,
  onClose,
  onSuccess,
}) => {
  const [fromLocation, setFromLocation] = useState('Main');
  const [toLocation, setToLocation] = useState('Secondary');
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [notes, setNotes] = useState('');
  const [transferMode, setTransferMode] = useState<'direct' | 'two_step'>('direct');
  const [lines, setLines] = useState<LineState[]>([newLine()]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lots, setLots] = useState<any[]>([]);

  useEffect(() => {
    if (!open) return;
    setFromLocation('Main');
    setToLocation('Secondary');
    setDate(new Date().toISOString().slice(0, 10));
    setNotes('');
    setTransferMode('direct');
    setLines([newLine(initialItemId != null ? String(initialItemId) : '')]);
    setError(null);
    setSubmitting(false);
    void commercialApi.listInventoryLots().then(setLots).catch(() => setLots([]));
  }, [open, initialItemId]);

  if (!open) return null;

  const itemById = new Map(items.map(i => [String(i.id), i]));

  const totalValue = lines.reduce((sum, line) => {
    const item = itemById.get(line.itemId);
    if (!item) return sum;
    return sum + (Number(line.quantity) || 0) * (Number(item.avgCost) || 0);
  }, 0);

  const updateLine = (key: string, patch: Partial<LineState>) => {
    setLines(prev => prev.map(l => (l.key === key ? { ...l, ...patch } : l)));
  };

  const submit = async () => {
    if (submitting) return;
    if (!fromLocation.trim() || !toLocation.trim()) {
      setError('Both a source and a destination location are required.');
      return;
    }
    if (fromLocation.trim().toLowerCase() === toLocation.trim().toLowerCase()) {
      setError('Source and destination locations must differ.');
      return;
    }
    const payload = lines
      .filter(l => l.itemId && Number(l.quantity) > 0)
      .map(l => ({ itemId: Number(l.itemId), quantity: String(Number(l.quantity)), lotId: l.lotId ? Number(l.lotId) : null }));

    if (payload.length === 0) {
      setError('Add at least one line with a quantity greater than zero.');
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      const result = await commercialApi.transferStock({
        fromLocation: fromLocation.trim(),
        toLocation: toLocation.trim(),
        transferDate: date,
        notes: notes.trim() || null,
        transferMode,
        lines: payload,
      });
      onSuccess(
        `Transferred ${payload.length} line${payload.length === 1 ? '' : 's'} from ${result.fromLocation} to ${result.toLocation} (${result.transferNumber}) · ${result.transferMode === 'two_step' ? 'in transit (receive to complete)' : 'no journal entry'}`
      );
      onClose();
    } catch (err: any) {
      setError(err?.message || 'Failed to post the stock transfer.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <ModalShell open={open} onClose={onClose} titleId="stock-transfer-modal-title" size="3xl">
      <ModalHeader
          titleId="stock-transfer-modal-title"
        title="Transfer Stock"
        subtitle="Move stock between storage locations"
        tone="brand"
        icon={<ArrowRightLeft className="h-4 w-4" />}
        onClose={onClose}
      />
      <form
        id="stock-transfer-form"
        onSubmit={e => {
          e.preventDefault();
          submit();
        }}
        className="flex min-h-0 flex-1 flex-col"
      >
        <ModalBody columns={2}>
          <FormSection title="Locations">
            <FormField label="From location" required>
              <input
                type="text"
                value={fromLocation}
                onChange={e => setFromLocation(e.target.value)}
                placeholder="Main"
                className="app-input"
                maxLength={120}
              />
            </FormField>
            <FormField label="To location" required>
              <input
                type="text"
                value={toLocation}
                onChange={e => setToLocation(e.target.value)}
                placeholder="Secondary"
                className="app-input"
                maxLength={120}
              />
            </FormField>
            <FormField label="Transfer date" required>
              <input
                type="date"
                value={date}
                onChange={e => setDate(e.target.value)}
                className="app-input font-mono"
              />
            </FormField>
            <FormField label="Transfer mode">
              <select value={transferMode} onChange={e => setTransferMode(e.target.value === 'two_step' ? 'two_step' : 'direct')} className="app-input">
                <option value="direct">Direct (immediate)</option>
                <option value="two_step">Two-step (dispatch to in-transit, then receive)</option>
              </select>
            </FormField>
            <FormField label="Notes">
              <textarea
                value={notes}
                onChange={e => setNotes(e.target.value)}
                rows={2}
                placeholder="Optional reason for the move"
                className="app-input resize-y"
              />
            </FormField>
          </FormSection>

          <FormSection title="Items to move">
            <div className="space-y-2">
              {lines.map(line => {
                const item = itemById.get(line.itemId);
                const overdraw =
                  item != null && Number(line.quantity) > Number(item.onHand) ? true : false;
                return (
                  <div key={line.key} className="surface space-y-2 p-3">
                    <div className="flex items-start gap-2">
                      <select
                        value={line.itemId}
                        onChange={e => updateLine(line.key, { itemId: e.target.value, lotId: '', lotSearch: '' })}
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
                          setLines(prev =>
                            prev.length === 1 ? prev : prev.filter(l => l.key !== line.key)
                          )
                        }
                        disabled={lines.length === 1}
                        aria-label="Remove line"
                        className="rounded-lg p-1.5 text-slate-400 transition hover:bg-rose-50 hover:text-rose-600 disabled:opacity-40 dark:hover:bg-rose-500/10"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                      <input
                        type="number"
                        min="0"
                        step="0.0001"
                        value={line.quantity}
                        onChange={e => updateLine(line.key, { quantity: e.target.value })}
                        placeholder="Qty"
                        aria-label="Quantity"
                        aria-invalid={overdraw}
                        className="app-input w-full font-mono"
                      />
                      <input
                        type="text"
                        value={line.lotSearch}
                        onChange={e => updateLine(line.key, { lotSearch: e.target.value })}
                        placeholder="Search lot..."
                        aria-label="Search lot"
                        className="app-input w-full"
                        disabled={!line.itemId}
                      />
                      <select
                        value={line.lotId}
                        onChange={e => updateLine(line.key, { lotId: e.target.value })}
                        className="app-input w-full"
                        aria-label="Lot"
                        disabled={!line.itemId}
                      >
                        <option value="">No lot</option>
                        {lots
                          .filter(l => String(l.itemId) === String(line.itemId))
                          .filter(l => !line.lotSearch || String(l.lotNumber || '').toLowerCase().includes(line.lotSearch.toLowerCase()) || String(l.supplierRollId || '').toLowerCase().includes(line.lotSearch.toLowerCase()))
                          .slice(0, 50)
                          .map(l => (
                            <option key={l.id} value={l.id}>{l.lotNumber}{l.supplierRollId ? ` · ${l.supplierRollId}` : ''}{l.quantityOnHand != null ? ` (${l.quantityOnHand})` : ''}</option>
                          ))}
                      </select>
                    </div>
                    {item && (
                      <div className="text-right font-mono text-[10px] text-slate-400">
                        {formatCurrency((Number(line.quantity) || 0) * (Number(item.avgCost) || 0))}
                      </div>
                    )}
                    {overdraw && (
                      <p className="text-[10px] font-semibold text-rose-600 dark:text-rose-400">
                        Exceeds {item?.onHand} at the source location.
                      </p>
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

            <div className="surface p-4">
              <SummaryRow label="Lines" value={lines.filter(l => l.itemId && Number(l.quantity) > 0).length} />
              <SummaryRow label="Transferred value" value={formatCurrency(totalValue)} emphasis tone="brand" />
            </div>
          </FormSection>

          <div className="lg:col-span-2">
            <SummaryRow
              label="Journal impact"
              value={transferMode === 'two_step'
                ? 'Dispatch posts DR 1320 Stock in Transit / CR Inventory Asset; receipt reverses it'
                : 'None — direct transfers are stock-neutral and do not post a journal entry'}
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
          submitLabel="Post Transfer"
          busy={submitting}
          disabled={lines.filter(l => l.itemId && Number(l.quantity) > 0).length === 0}
        />
      </form>
    </ModalShell>
  );
};

export default StockTransferModal;