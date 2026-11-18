import { useEffect, useState } from 'react';
import { AlertTriangle, Pencil } from 'lucide-react';
import { commercialApi } from '../../services/commercialApi';
import {
  FormField,
  FormSection,
  ModalBody,
  ModalFooter,
  ModalHeader,
  ModalShell,
  SummaryRow,
} from '../common/ui';

/**
 * Rename and re-describe an inventory item.
 *
 * This edits master data only. It deliberately does not touch `on_hand` or
 * `avg_cost`: quantities are owned by the perpetual stock ledger and valuation
 * by the general ledger, so an item edit can never move a balance.
 *
 * Cost fields are scoped by item type — a raw material carries a purchase cost
 * and unit conversion, while sellable items carry a selling price. The server
 * re-validates both rules, so the field gating here is a convenience, not the
 * security boundary.
 */

export interface EditItemModalProps {
  open: boolean;
  item: {
    id: string | number;
    sku: string;
    name: string;
    type: string;
    description?: string;
    reorderPoint?: number;
    cost?: number;
    salesPrice?: number;
    purchaseUnit?: string;
    usageUnit?: string;
    conversionFactor?: number;
  } | null;
  onClose: () => void;
  onSuccess: (message: string) => void;
}

export const EditItemModal: React.FC<EditItemModalProps> = ({
  open,
  item,
  onClose,
  onSuccess,
}) => {
  const [sku, setSku] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [reorderPoint, setReorderPoint] = useState('0');
  const [unitCost, setUnitCost] = useState('0');
  const [salesPrice, setSalesPrice] = useState('0');
  const [purchaseUnit, setPurchaseUnit] = useState('Unit');
  const [usageUnit, setUsageUnit] = useState('Unit');
  const [conversionFactor, setConversionFactor] = useState('1');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !item) return;
    setSku(item.sku);
    setName(item.name);
    setDescription(item.description ?? '');
    setReorderPoint(String(item.reorderPoint ?? 0));
    setUnitCost(String(item.cost ?? 0));
    setSalesPrice(String(item.salesPrice ?? 0));
    setPurchaseUnit(item.purchaseUnit || 'Unit');
    setUsageUnit(item.usageUnit || 'Unit');
    setConversionFactor(String(item.conversionFactor ?? 1));
    setError(null);
    setSubmitting(false);
  }, [open, item]);

  if (!open || !item) return null;

  const isRaw = item.type === 'raw_material';
  const backendId = Number(item.id);
  const skuChanged = sku.trim().toLowerCase() !== item.sku.toLowerCase();
  const conversionInvalid = Number(conversionFactor) <= 0;

  const submit = async () => {
    if (submitting) return;
    if (!Number.isInteger(backendId) || backendId <= 0) {
      setError('This item is not linked to a server record yet, so it cannot be updated.');
      return;
    }
    if (!sku.trim()) {
      setError('SKU is required.');
      return;
    }
    if (!name.trim()) {
      setError('Item name is required.');
      return;
    }
    if (conversionInvalid) {
      setError('Conversion factor must be greater than zero.');
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      const result = await commercialApi.updateInventoryItem(backendId, {
        sku: sku.trim(),
        name: name.trim(),
        description: description.trim() || null,
        reorderPoint: reorderPoint.trim() === '' ? 0 : Number(reorderPoint),
        unitCost: isRaw ? (unitCost.trim() === '' ? 0 : Number(unitCost)) : undefined,
        salesPrice: isRaw ? 0 : salesPrice.trim() === '' ? 0 : Number(salesPrice),
        purchaseUnit: isRaw ? purchaseUnit.trim() || 'Unit' : undefined,
        usageUnit: isRaw ? usageUnit.trim() || 'Unit' : undefined,
        conversionFactor: isRaw ? Number(conversionFactor) : undefined,
      });
      const renamed = result.sku !== item.sku;
      onSuccess(
        renamed
          ? `Renamed ${item.sku} to ${result.sku} — ${result.name}`
          : `Updated ${result.sku} — ${result.name}`
      );
      onClose();
    } catch (err: any) {
      setError(err?.message || 'Failed to update the inventory item.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <ModalShell open={open} onClose={onClose} titleId="edit-item-modal-title" size="2xl">
      <ModalHeader
        title="Edit Item Details"
        subtitle={`Update master data for ${item.sku}`}
        tone="brand"
        icon={<Pencil className="h-4 w-4" />}
        onClose={onClose}
      />
      <form
        id="edit-item-form"
        onSubmit={e => {
          e.preventDefault();
          submit();
        }}
        className="flex min-h-0 flex-1 flex-col"
      >
        <ModalBody columns={2}>
          <FormSection title="Identity">
            <FormField
              label="SKU"
              required
              hint={skuChanged ? `Renames ${item.sku} → ${sku.trim() || '…'}` : 'Unique within the company'}
            >
              <input
                type="text"
                value={sku}
                onChange={e => setSku(e.target.value)}
                maxLength={64}
                className="app-input font-mono"
              />
            </FormField>

            <FormField label="Item name" required>
              <input
                type="text"
                value={name}
                onChange={e => setName(e.target.value)}
                maxLength={200}
                className="app-input"
              />
            </FormField>

            <FormField label="Description">
              <textarea
                value={description}
                onChange={e => setDescription(e.target.value)}
                rows={3}
                placeholder="Optional description"
                className="app-input resize-y"
              />
            </FormField>

            <FormField
              label="Reorder point"
              hint="Alert level used by low-stock reporting"
            >
              <input
                type="number"
                min="0"
                step="0.0001"
                value={reorderPoint}
                onChange={e => setReorderPoint(e.target.value)}
                className="app-input font-mono"
              />
            </FormField>
          </FormSection>

          <FormSection title={isRaw ? 'Cost & units' : 'Selling price'}>
            {isRaw ? (
              <>
                <FormField label="Purchase cost" hint="Cost per purchase unit">
                  <input
                    type="number"
                    min="0"
                    step="0.0001"
                    value={unitCost}
                    onChange={e => setUnitCost(e.target.value)}
                    className="app-input font-mono"
                  />
                </FormField>

                <div className="grid grid-cols-2 gap-3">
                  <FormField label="Purchase unit">
                    <input
                      type="text"
                      value={purchaseUnit}
                      onChange={e => setPurchaseUnit(e.target.value)}
                      placeholder="Ream"
                      className="app-input"
                    />
                  </FormField>
                  <FormField label="Usage unit">
                    <input
                      type="text"
                      value={usageUnit}
                      onChange={e => setUsageUnit(e.target.value)}
                      placeholder="Sheet"
                      className="app-input"
                    />
                  </FormField>
                </div>

                <FormField
                  label="Conversion factor"
                  required
                  hint={`1 ${purchaseUnit || 'purchase unit'} = how many ${usageUnit || 'usage units'}?`}
                >
                  <input
                    type="number"
                    min="0.0001"
                    step="0.0001"
                    value={conversionFactor}
                    onChange={e => setConversionFactor(e.target.value)}
                    aria-invalid={conversionInvalid}
                    className="app-input font-mono"
                  />
                </FormField>
                {conversionInvalid && (
                  <p className="text-[11px] font-semibold text-rose-600 dark:text-rose-400">
                    Conversion factor must be greater than zero.
                  </p>
                )}

                <p className="rounded-lg bg-slate-50 p-3 text-[10px] leading-relaxed text-slate-500 dark:bg-white/5 dark:text-slate-400">
                  Raw materials are never sold directly, so they carry no selling price.
                </p>
              </>
            ) : (
              <>
                <FormField label="Selling price">
                  <input
                    type="number"
                    min="0"
                    step="0.0001"
                    value={salesPrice}
                    onChange={e => setSalesPrice(e.target.value)}
                    className="app-input font-mono"
                  />
                </FormField>
                <p className="rounded-lg bg-slate-50 p-3 text-[10px] leading-relaxed text-slate-500 dark:bg-white/5 dark:text-slate-400">
                  Selling price does not affect stock quantity or valuation.
                </p>
              </>
            )}
          </FormSection>

          <div className="lg:col-span-2">
            <SummaryRow
              label="Stock & valuation"
              value="Unchanged — quantities live in the stock ledger, not in master data"
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
          submitLabel={skuChanged ? 'Save & Rename' : 'Save Changes'}
          submitIcon={<Pencil className="h-3.5 w-3.5" />}
          busy={submitting}
          disabled={
            !sku.trim() ||
            !name.trim() ||
            conversionInvalid ||
            !Number.isInteger(backendId) ||
            backendId <= 0
          }
        />
      </form>
    </ModalShell>
  );
};

export default EditItemModal;