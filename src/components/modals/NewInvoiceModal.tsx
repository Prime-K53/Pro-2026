import React, { useState, useEffect } from 'react';
import { useAccounting } from '../../context/AccountingContext';
import { formatCurrency } from '../../utils/currency';
import { commercialApi, ApiCustomer } from '../../services/commercialApi';
import { FileText, Plus, Trash2, Save, Package, Receipt, User, Calendar, StickyNote } from 'lucide-react';
import {
  ModalShell,
  ModalHeader,
  ModalFooter,
  ModalBody,
  FormSection,
  FormField,
  SummaryRow,
  InlineAlert,
} from '../common/ui';

type Line = {
  id: string;
  itemId: string;
  description: string;
  quantity: number;
  rate: number;
  taxable: boolean;
};

export const NewInvoiceModal: React.FC = () => {
  const { isNewInvoiceOpen, setIsNewInvoiceOpen, companyProfile, triggerShortcutNotice } = useAccounting();
  const currency = companyProfile.currency || 'K';

  const [customers, setCustomers] = useState<ApiCustomer[]>([]);
  const [items, setItems] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [customerId, setCustomerId] = useState<string>('');
  const [date, setDate] = useState(new Date().toISOString().split('T')[0]);
  const [terms, setTerms] = useState<'Due on Receipt' | 'Net 15' | 'Net 30' | 'Net 60'>('Net 30');
  const [dueDate, setDueDate] = useState('');
  const [notes, setNotes] = useState('');

  const calculateDueDate = (startDate: string, term: string) => {
    const d = new Date(startDate);
    if (term === 'Net 15') d.setDate(d.getDate() + 15);
    else if (term === 'Net 30') d.setDate(d.getDate() + 30);
    else if (term === 'Net 60') d.setDate(d.getDate() + 60);
    else d.setDate(d.getDate());
    return d.toISOString().split('T')[0];
  };

  useEffect(() => { setDueDate(calculateDueDate(date, terms)); }, [date, terms]);

  const [lines, setLines] = useState<Line[]>([
    { id: 'l-1', itemId: '', description: '', quantity: 1, rate: 0, taxable: true },
  ]);

  useEffect(() => {
    if (!isNewInvoiceOpen) return;
    setLoading(true);
    setError(null);
    Promise.all([
      commercialApi.listCustomers().catch(() => [] as ApiCustomer[]),
      commercialApi.listInventory().catch(() => [] as any[]),
    ]).then(([custs, its]) => {
      setCustomers(custs);
      setItems(its);
      if (custs.length && !customerId) setCustomerId(String(custs[0].id));
      setLoading(false);
    }).catch(err => { setError(err?.message || 'Failed to load data'); setLoading(false); });
  }, [isNewInvoiceOpen]);

  if (!isNewInvoiceOpen) return null;

  const handleItemSelect = (lineId: string, itemId: string) => {
    const item = items.find(i => String(i.id) === itemId);
    setLines(prev => prev.map(line => line.id === lineId ? {
      ...line, itemId, description: item?.name || '', rate: Number(item?.sales_price || 0),
    } : line));
  };
  const handleQtyChange = (lineId: string, quantity: number) => {
    setLines(prev => prev.map(line => line.id === lineId ? { ...line, quantity: Math.max(1, quantity) } : line));
  };
  const handleRateChange = (lineId: string, rate: number) => {
    setLines(prev => prev.map(line => line.id === lineId ? { ...line, rate } : line));
  };
  const handleDescriptionChange = (lineId: string, description: string) => {
    setLines(prev => prev.map(line => line.id === lineId ? { ...line, description } : line));
  };
  const handleTaxableToggle = (lineId: string) => {
    setLines(prev => prev.map(line => line.id === lineId ? { ...line, taxable: !line.taxable } : line));
  };
  const addLine = () => setLines(prev => [...prev, { id: `l-${Date.now()}`, itemId: '', description: '', quantity: 1, rate: 0, taxable: true }]);
  const removeLine = (lineId: string) => { if (lines.length > 1) setLines(prev => prev.filter(l => l.id !== lineId)); };

  const subtotal = lines.reduce((sum, l) => sum + l.quantity * l.rate, 0);
  const taxableSubtotal = lines.filter(l => l.taxable).reduce((sum, l) => sum + l.quantity * l.rate, 0);
  const taxRate = companyProfile.salesTaxRate || 0;
  const taxAmount = taxableSubtotal * taxRate;
  const total = subtotal + taxAmount;
  const hasValidLines = lines.every(l => l.description.trim().length > 0) && subtotal > 0;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!customerId || !hasValidLines) return;
    setSubmitting(true);
    setError(null);
    try {
      const payloadLines = lines.map(l => ({
        itemId: l.itemId ? Number(l.itemId) : null,
        description: l.description.trim() || 'Printing Service / Product',
        quantity: String(l.quantity),
        rate: String(l.rate),
        unitCost: '0',
        taxable: l.taxable,
      }));
      const inv = await commercialApi.createInvoice({
        customerId: Number(customerId),
        invoiceDate: date,
        dueDate,
        terms,
        taxRate: String(taxRate),
        notes: notes || undefined,
        lines: payloadLines,
      });
      triggerShortcutNotice?.(`Created Invoice ${inv.invoiceNumber}`);
      setIsNewInvoiceOpen(false);
    } catch (err: any) {
      setError(err?.message || 'Invoice creation failed');
    } finally {
      setSubmitting(false);
    }
  };

  const close = () => setIsNewInvoiceOpen(false);
  const selectedCustomer = customers.find(c => String(c.id) === customerId);

  return (
    <ModalShell open={isNewInvoiceOpen} onClose={close} size="4xl" titleId="invoice-modal-title">
      <ModalHeader
        title="Create Invoice"
        subtitle="Bill a customer for printing products or services"
        icon={<FileText className="h-4 w-4" />}
        tone="brand"
        onClose={close}
      />
      <form id="invoice-form" onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col">
        <ModalBody columns={2}>
          {/* LEFT: Line items */}
          <div className="space-y-4">
            <FormSection title="Line Items" icon={<Package className="h-3 w-3" />}>
              <div className="surface overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[560px]">
                    <thead>
                      <tr className="border-b border-slate-200 bg-slate-50/80 text-[10px] font-bold uppercase tracking-wider text-slate-500 dark:border-white/[0.06] dark:bg-white/[0.03] dark:text-slate-400">
                        <th className="px-2 py-2 text-left">Item / Description</th>
                        <th className="px-2 py-2 text-center w-16">Qty</th>
                        <th className="px-2 py-2 text-right w-24">Rate</th>
                        <th className="px-2 py-2 text-right w-24">Amount</th>
                        <th className="px-2 py-2 text-center w-12">Tax</th>
                        <th className="px-2 py-2 w-8"></th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 dark:divide-white/[0.05]">
                      {lines.map((line, idx) => {
                        const selectedItem = items.find(i => String(i.id) === line.itemId);
                        const onHand = selectedItem ? Number(selectedItem.on_hand ?? selectedItem.onHand ?? 0) : null;
                        return (
                          <tr key={line.id} className="align-top transition-colors hover:bg-brand-50/30 dark:hover:bg-white/[0.02]">
                            <td className="px-2 py-2">
                              <select
                                value={line.itemId}
                                onChange={e => handleItemSelect(line.id, e.target.value)}
                                className="app-input !py-1.5 !text-xs"
                              >
                                <option value="">-- Custom line --</option>
                                {items.map(item => (
                                  <option key={item.id} value={item.id}>
                                    {item.name} ({formatCurrency(Number(item.sales_price || 0), currency)})
                                  </option>
                                ))}
                              </select>
                              <input
                                type="text"
                                value={line.description}
                                onChange={e => handleDescriptionChange(line.id, e.target.value)}
                                placeholder="Line description"
                                className="mt-1 w-full rounded border-0 border-b border-transparent bg-transparent px-1 py-1 text-[11px] text-slate-600 outline-none focus:border-brand-500 dark:text-slate-300"
                              />
                              {onHand !== null && onHand >= 0 && (
                                <div className="mt-0.5 text-[10px] text-slate-400">
                                  {onHand} in stock
                                </div>
                              )}
                            </td>
                            <td className="px-2 py-2">
                              <input
                                type="number" min="1" step="1"
                                value={line.quantity}
                                onChange={e => handleQtyChange(line.id, parseFloat(e.target.value) || 1)}
                                className="app-input !w-14 !px-1.5 !py-1.5 text-center !text-xs"
                              />
                            </td>
                            <td className="px-2 py-2">
                              <input
                                type="number" step="0.01"
                                value={line.rate}
                                onChange={e => handleRateChange(line.id, parseFloat(e.target.value) || 0)}
                                className="app-input !w-20 !px-1.5 !py-1.5 text-right !text-xs"
                              />
                            </td>
                            <td className="px-2 py-2 text-right font-mono text-xs font-semibold tabular-nums text-slate-900 dark:text-white whitespace-nowrap">
                              {formatCurrency(line.quantity * line.rate, currency)}
                            </td>
                            <td className="px-2 py-2 text-center">
                              <input
                                type="checkbox"
                                checked={line.taxable}
                                onChange={() => handleTaxableToggle(line.id)}
                                className="h-3.5 w-3.5 rounded border-slate-300 text-brand-600 focus:ring-brand-500/30"
                              />
                            </td>
                            <td className="px-2 py-2 text-center">
                              {lines.length > 1 && (
                                <button
                                  type="button"
                                  onClick={() => removeLine(line.id)}
                                  className="rounded p-1 text-slate-400 transition-colors hover:bg-rose-50 hover:text-rose-500 dark:hover:bg-rose-950/40"
                                  title="Remove line"
                                >
                                  <Trash2 className="h-3.5 w-3.5" />
                                </button>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <div className="flex items-center justify-between border-t border-slate-200 bg-slate-50/60 px-3 py-2 dark:border-white/[0.06] dark:bg-white/[0.02]">
                  <button
                    type="button"
                    onClick={addLine}
                    className="flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs font-semibold text-brand-600 transition-colors hover:bg-brand-50 dark:text-brand-400 dark:hover:bg-brand-500/10"
                  >
                    <Plus className="h-3.5 w-3.5" />
                    Add Line
                  </button>
                  <div className="font-mono text-[11px] text-slate-500 dark:text-slate-400">
                    {lines.length} line{lines.length === 1 ? '' : 's'}
                  </div>
                </div>
              </div>
            </FormSection>

            <FormSection title="Notes" icon={<StickyNote className="h-3 w-3" />}>
              <textarea
                value={notes}
                onChange={e => setNotes(e.target.value)}
                rows={3}
                placeholder="Internal notes, PO number, delivery instructions..."
                className="app-input resize-none"
              />
            </FormSection>
          </div>

          {/* RIGHT: Invoice details + summary */}
          <div className="space-y-4">
            <FormSection title="Customer" icon={<User className="h-3 w-3" />} aside>
              <FormField label="Bill To" required>
                <select
                  value={customerId}
                  onChange={e => setCustomerId(e.target.value)}
                  className="app-input"
                  required
                >
                  {customers.length === 0 && <option value="">No customers</option>}
                  {customers.map(c => (
                    <option key={c.id} value={c.id}>{c.companyName}{c.name ? ` (${c.name})` : ''}</option>
                  ))}
                </select>
              </FormField>
              {selectedCustomer && (
                <div className="mt-2 rounded-lg bg-slate-50/80 p-2.5 text-[11px] dark:bg-white/[0.03]">
                  <div className="font-semibold text-slate-700 dark:text-slate-200">{selectedCustomer.companyName}</div>
                  {selectedCustomer.email && <div className="text-slate-500 dark:text-slate-400">{selectedCustomer.email}</div>}
                  {selectedCustomer.phone && <div className="text-slate-500 dark:text-slate-400">{selectedCustomer.phone}</div>}
                  {selectedCustomer.address && <div className="mt-0.5 text-slate-500 dark:text-slate-400">{selectedCustomer.address}</div>}
                </div>
              )}
            </FormSection>

            <FormSection title="Invoice Details" icon={<Calendar className="h-3 w-3" />} aside>
              <div className="space-y-2.5">
                <FormField label="Invoice Date" required>
                  <input
                    type="date"
                    value={date}
                    onChange={e => setDate(e.target.value)}
                    className="app-input"
                    required
                  />
                </FormField>
                <div className="grid grid-cols-2 gap-2">
                  <FormField label="Terms">
                    <select
                      value={terms}
                      onChange={e => setTerms(e.target.value as any)}
                      className="app-input"
                    >
                      <option value="Due on Receipt">Due on Receipt</option>
                      <option value="Net 15">Net 15</option>
                      <option value="Net 30">Net 30</option>
                      <option value="Net 60">Net 60</option>
                    </select>
                  </FormField>
                  <FormField label="Due Date">
                    <input
                      type="date"
                      value={dueDate}
                      onChange={e => setDueDate(e.target.value)}
                      className="app-input"
                    />
                  </FormField>
                </div>
                <div className="flex items-center justify-between rounded-lg bg-slate-50/80 px-3 py-2 text-[11px] dark:bg-white/[0.03]">
                  <span className="text-slate-500 dark:text-slate-400">Tax Rate</span>
                  <span className="font-mono font-semibold text-slate-700 dark:text-slate-200">
                    {(taxRate * 100).toFixed(1)}%
                  </span>
                </div>
              </div>
            </FormSection>

            <FormSection title="Summary" icon={<Receipt className="h-3 w-3" />} aside>
              <SummaryRow label="Subtotal" value={formatCurrency(subtotal, currency)} />
              <SummaryRow
                label={`Tax (${(taxRate * 100).toFixed(1)}%)`}
                value={formatCurrency(taxAmount, currency)}
                tone="amber"
              />
              <SummaryRow label="Total" value={formatCurrency(total, currency)} emphasis tone="brand" />
            </FormSection>
          </div>
        </ModalBody>
        {error && (
          <div className="px-5 pb-2">
            <InlineAlert tone="error">{error}</InlineAlert>
          </div>
        )}
        <ModalFooter
          onCancel={close}
          submitLabel="Save & Post Invoice"
          submitIcon={<Save className="h-3.5 w-3.5" />}
          form="invoice-form"
          disabled={!customerId || !hasValidLines}
          busy={submitting}
          left={<div className="text-[11px] text-slate-500 dark:text-slate-400">{selectedCustomer?.companyName || 'No customer selected'}</div>}
        />
      </form>
    </ModalShell>
  );
};