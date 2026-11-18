import { useEffect, useState } from 'react';
import { AlertTriangle, PackageMinus } from 'lucide-react';
import { commercialApi } from '../../services/commercialApi';
import { formatCurrency } from '../../utils/currency';
import { FormField, FormSection, ModalBody, ModalFooter, ModalHeader, ModalShell, SummaryRow } from '../common/ui';

/**
 * Damage / spoilage write-off.
 *
 * The quantity and unit cost the operator enters are only used to show a live
 * estimate of the value being written off. The authoritative value is computed
 * server-side from the stored moving average inside the same transaction that
 * posts the journal entry, so the preview can never become the posted figure.
 */

export interface StockDamageModalProps {
  open: boolean;
  item: { id: string | number; sku: string; name: string; onHand: number; avgCost?: number } | null;
  onClose: () => void;
  onSuccess: (message: string) => void;
}

const REASON_CODES: Array<{ value: string; label: string }> = [
  { value: 'damaged', label: 'Damaged' },
  { value: 'spoiled', label: 'Spoiled / expired' },
  { value: 'lost', label: 'Lost / missing' },
  { value: 'theft', label: 'Theft' },
  { value: 'obsolete', label: 'Obsolete' },
  { value: 'other', label: 'Other' },
];

export const StockDamageModal: React.FC<StockDamageModalProps> = ({
  open,
  item,
  onClose,
  onSuccess,
}) => {
  const titleId = 'stock-damage-modal-title';
  const [quantity, setQuantity] = useState('');
  const [reasonCode, setReasonCode] = useState('damaged');
  const [reason, setReason] = useState('');
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setQuantity('');
    setReasonCode('damaged');
    setReason('');
    setDate(new Date().toISOString().slice(0, 10));
    setError(null);
    setSubmitting(false);
  }, [open, item?.id]);

  if (!open || !item) return null;

  const backendId = Number(item.id);
  const onHand = Number(item.onHand) || 0;
  const unitCost = Number(item.avgCost ?? 0);
  const qty = Number(quantity) || 0;
  const estimatedValue = qty * unitCost;
  const exceedsOnHand = qty > onHand;

  const submit = async () => {
    if (submitting) return;
    if (!Number.isInteger(backendId) || backendId <= 0) {
      setError('This item is not linked to a server record yet, so no stock movement can be posted.');
      return;
    }
    if (qty <= 0) {
      setError('Enter a damage quantity greater than zero.');
      return;
    }
    if (exceedsOnHand) {
      setError(`Cannot damage ${qty} — only ${onHand} on hand.`);
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const result = await commercialApi.recordStockDamage(backendId, {
        quantity: String(qty),
        reasonCode,
        reason: reason.trim() || null,
        damageDate: date,
      });
      onSuccess(
        `Wrote off ${result.quantity} of ${result.sku} (${formatCurrency(Number(result.value))}) · ${result.entryNumber} · new on hand ${result.onHandAfter}`
      );
      onClose();
    } catch (err: any) {
      setError(err?.message || 'Failed to record the stock damage.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <ModalShell open={open} onClose={onClose} titleId={titleId} size="2xl">
      <ModalHeader
        title="Record Stock Damage"
        subtitle="Write off damaged or lost stock"
        tone="rose"
        icon={<PackageMinus className="h-4 w-4" />}
        onClose={onClose}
      />
      <form
        id="stock-damage-form"
        onSubmit={e => {
          e.preventDefault();
          submit();
        }}
        className="flex min-h-0 flex-1 flex-col"
      >
        <ModalBody columns={2}>
          <FormSection title="Item">
            <div className="surface space-y-1 p-4 text-xs">
              <div className="text-sm font-bold text-slate-900 dark:text-white">{item.name}</div>
              <div className="font-mono text-[11px] text-slate-500">SKU {item.sku}</div>
              <div className="flex justify-between gap-3 pt-2 text-slate-600 dark:text-slate-300">
                <span>On hand</span>
                <span className="font-mono font-bold">{onHand}</span>
              </div>
              <div className="flex justify-between gap-3 text-slate-600 dark:text-slate-300">
                <span>Avg cost</span>
                <span className="font-mono font-bold">{formatCurrency(unitCost)}</span>
              </div>
            </div>

            <FormField label="Damage quantity" required hint={`Maximum ${onHand}`}>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  min="0"
                  step="0.0001"
                  value={quantity}
                  onChange={e => setQuantity(e.target.value)}
                  placeholder="0"
                  className="app-input w-full font-mono"
                  aria-invalid={exceedsOnHand}
                />
                {qty > 0 && (
                  <button
                    type="button"
                    onClick={() => setQuantity(String(onHand))}
                    className="btn-secondary shrink-0 px-2 py-1.5 text-[10px]"
                  >
                    All
                  </button>
                )}
              </div>
            </FormField>
            {exceedsOnHand && (
              <p className="text-[11px] font-semibold text-rose-600 dark:text-rose-400">
                Quantity exceeds the {onHand} on hand.
              </p>
            )}
          </FormSection>

          <FormSection title="Reason & date">
            <FormField label="Reason code">
              <select
                value={reasonCode}
                onChange={e => setReasonCode(e.target.value)}
                className="app-input"
              >
                {REASON_CODES.map(r => (
                  <option key={r.value} value={r.value}>
                    {r.label}
                  </option>
                ))}
              </select>
            </FormField>

            <FormField label="Notes">
              <textarea
                value={reason}
                onChange={e => setReason(e.target.value)}
                rows={2}
                placeholder="Optional context for the write-off"
                className="app-input resize-y"
              />
            </FormField>

            <FormField label="Damage date" required>
              <input
                type="date"
                value={date}
                onChange={e => setDate(e.target.value)}
                className="app-input font-mono"
              />
            </FormField>

            <div className="surface p-4">
              <div className="mb-1.5 text-[10px] font-bold uppercase tracking-[0.09em] text-slate-500">
                Value to write off
              </div>
              <div className="font-mono text-lg font-bold text-rose-600 dark:text-rose-400">
                {formatCurrency(estimatedValue)}
              </div>
              <p className="mt-1 text-[10px] text-slate-400">
                Preview only. The server recomputes this from the stored moving average when it posts.
              </p>
            </div>
          </FormSection>

          <div className="lg:col-span-2">
            <SummaryRow label="Journal impact" value="Inventory asset credited, shrinkage/expense debited" />
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
          tone="rose"
          submitLabel="Write Off Stock"
          busy={submitting}
          disabled={qty <= 0 || exceedsOnHand || !Number.isInteger(backendId) || backendId <= 0}
        />
      </form>
    </ModalShell>
  );
};

export default StockDamageModal;