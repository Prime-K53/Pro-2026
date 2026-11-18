import React, { useState, useEffect } from 'react';
import { useAccounting } from '../../context/AccountingContext';
import { formatCurrency } from '../../utils/currency';
import { commercialApi, ApiVendor } from '../../services/commercialApi';
import { accountingApi, ApiAccount } from '../../services/accountingApi';
import { Plus, Trash2, Receipt, Save, Building2, Calendar, StickyNote } from 'lucide-react';
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
  accountId: string;
  description: string;
  quantity: number;
  amount: number;
  taxable: boolean;
};

export const EnterBillModal: React.FC = () => {
  const { isEnterBillOpen, setIsEnterBillOpen, companyProfile, triggerShortcutNotice } = useAccounting();
  const currency = companyProfile.currency || 'K';

  const [vendors, setVendors] = useState<ApiVendor[]>([]);
  const [expenseAccounts, setExpenseAccounts] = useState<ApiAccount[]>([]);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [vendorId, setVendorId] = useState<string>('');
  const [date, setDate] = useState(new Date().toISOString().split('T')[0]);
  const [terms, setTerms] = useState<'Due on Receipt' | 'Net 15' | 'Net 30' | 'Net 60'>('Net 30');
  const [dueDate, setDueDate] = useState('');
  const [billNumber, setBillNumber] = useState('');
  const [memo, setMemo] = useState('');

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
    { id: 'bl-1', accountId: '', description: 'Material shipment', quantity: 1, amount: 0, taxable: false },
  ]);

  useEffect(() => {
    if (!isEnterBillOpen) return;
    setLoading(true);
    setError(null);
    Promise.all([
      commercialApi.listVendors().catch(() => [] as ApiVendor[]),
      accountingApi.listAccounts(true).catch(() => [] as ApiAccount[]),
    ]).then(([vs, accts]) => {
      setVendors(vs);
      const exp = accts.filter(a => ['Expense', 'CostOfGoodsSold', 'OtherExpense'].includes(a.account_type));
      setExpenseAccounts(exp);
      if (vs.length && !vendorId) setVendorId(String(vs[0].id));
      if (exp.length) setLines(prev => prev.map(l => l.accountId ? l : { ...l, accountId: String(exp[0].id) }));
      setLoading(false);
    }).catch(err => { setError(err?.message || 'Failed to load data'); setLoading(false); });
  }, [isEnterBillOpen]);

  if (!isEnterBillOpen) return null;

  const handleAccountChange = (lineId: string, accountId: string) => {
    setLines(prev => prev.map(line => (line.id === lineId ? { ...line, accountId } : line)));
  };
  const handleDescriptionChange = (lineId: string, description: string) => {
    setLines(prev => prev.map(line => (line.id === lineId ? { ...line, description } : line)));
  };
  const handleQuantityChange = (lineId: string, quantity: number) => {
    setLines(prev => prev.map(line => (line.id === lineId ? { ...line, quantity: Math.max(1, quantity) } : line)));
  };
  const handleAmountChange = (lineId: string, amount: number) => {
    setLines(prev => prev.map(line => (line.id === lineId ? { ...line, amount: Math.max(0, amount) } : line)));
  };
  const handleTaxableToggle = (lineId: string) => {
    setLines(prev => prev.map(line => (line.id === lineId ? { ...line, taxable: !line.taxable } : line)));
  };
  const addLine = () => {
    setLines(prev => [...prev, { id: `bl-${Date.now()}`, accountId: expenseAccounts[0] ? String(expenseAccounts[0].id) : '', description: '', quantity: 1, amount: 0, taxable: false }]);
  };
  const removeLine = (lineId: string) => {
    if (lines.length > 1) setLines(prev => prev.filter(l => l.id !== lineId));
  };

  const subtotal = lines.reduce((sum, l) => sum + l.amount, 0);
  const taxRate = companyProfile.salesTaxRate || 0;
  const taxableSubtotal = lines.filter(l => l.taxable).reduce((sum, l) => sum + l.amount, 0);
  const taxAmount = taxableSubtotal * taxRate;
  const total = Math.round((subtotal + taxAmount) * 100) / 100;
  const hasValidLines = lines.every(l => l.accountId && l.amount > 0);
  const canSubmit = !!vendorId && total > 0 && hasValidLines;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await commercialApi.createBill({
        vendorId: Number(vendorId),
        billDate: date,
        dueDate,
        terms,
        billNumber: billNumber || undefined,
        memo: memo || undefined,
        taxRate: String(taxRate),
        lines: lines.map(l => ({
          accountId: l.accountId ? Number(l.accountId) : undefined,
          description: l.description.trim() || 'Supplier Purchase',
          quantity: String(l.quantity),
          unitCost: String(l.amount),
          taxable: l.taxable,
        })),
      });
      triggerShortcutNotice?.(`Posted Bill ${res.billNumber} to Accounts Payable & GL`);
      setIsEnterBillOpen(false);
    } catch (err: any) {
      setError(err?.message || 'Failed to post bill');
    } finally {
      setSubmitting(false);
    }
  };

  const close = () => setIsEnterBillOpen(false);
  const selectedVendor = vendors.find(v => String(v.id) === vendorId);

  return (
    <ModalShell open={isEnterBillOpen} onClose={close} size="4xl" titleId="bill-modal-title">
      <ModalHeader
        title="Enter Vendor Bill"
        subtitle="Record a supplier bill split across expense accounts"
        icon={<Receipt className="h-4 w-4" />}
        tone="slate"
        onClose={close}
      />
      <form id="bill-form" onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col">
        <ModalBody columns={2}>
          {/* LEFT: Expense lines */}
          <div className="space-y-4">
            <FormSection title="Expense Lines" icon={<Receipt className="h-3 w-3" />}>
              <div className="surface overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[560px]">
                    <thead>
                      <tr className="border-b border-slate-200 bg-slate-50/80 text-[10px] font-bold uppercase tracking-wider text-slate-500 dark:border-white/[0.06] dark:bg-white/[0.03] dark:text-slate-400">
                        <th className="px-2 py-2 text-left">Expense Account</th>
                        <th className="px-2 py-2 text-left">Description</th>
                        <th className="px-2 py-2 text-center w-14">Qty</th>
                        <th className="px-2 py-2 text-right w-24">Amount</th>
                        <th className="px-2 py-2 text-center w-12">Tax</th>
                        <th className="px-2 py-2 w-8"></th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 dark:divide-white/[0.05]">
                      {lines.map(line => (
                        <tr key={line.id} className="align-top transition-colors hover:bg-brand-50/30 dark:hover:bg-white/[0.02]">
                          <td className="px-2 py-2">
                            <select
                              value={line.accountId}
                              onChange={e => handleAccountChange(line.id, e.target.value)}
                              className="app-input !py-1.5 !text-xs"
                              required
                            >
                              {expenseAccounts.map(acc => (
                                <option key={acc.id} value={acc.id}>{acc.code} — {acc.name}</option>
                              ))}
                            </select>
                          </td>
                          <td className="px-2 py-2">
                            <input
                              type="text"
                              value={line.description}
                              onChange={e => handleDescriptionChange(line.id, e.target.value)}
                              placeholder="Line memo..."
                              className="app-input !py-1.5 !text-xs"
                            />
                          </td>
                          <td className="px-2 py-2">
                            <input
                              type="number" min="1" step="1"
                              value={line.quantity}
                              onChange={e => handleQuantityChange(line.id, parseFloat(e.target.value) || 1)}
                              className="app-input !w-14 !px-1.5 !py-1.5 text-center !text-xs"
                            />
                          </td>
                          <td className="px-2 py-2">
                            <input
                              type="number" step="0.01" min="0"
                              value={line.amount}
                              onChange={e => handleAmountChange(line.id, parseFloat(e.target.value) || 0)}
                              className="app-input !w-20 !px-1.5 !py-1.5 text-right !text-xs"
                            />
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
                      ))}
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
                    Add Expense Line
                  </button>
                  <div className="font-mono text-[11px] text-slate-500 dark:text-slate-400">
                    {lines.length} line{lines.length === 1 ? '' : 's'}
                  </div>
                </div>
              </div>
            </FormSection>

            <FormSection title="Memo" icon={<StickyNote className="h-3 w-3" />}>
              <textarea
                value={memo}
                onChange={e => setMemo(e.target.value)}
                rows={2}
                placeholder="Overall bill memo, PO reference, delivery notes..."
                className="app-input resize-none"
              />
            </FormSection>
          </div>

          {/* RIGHT: Bill details + summary */}
          <div className="space-y-4">
            <FormSection title="Vendor" icon={<Building2 className="h-3 w-3" />} aside>
              <FormField label="Vendor" required>
                <select
                  value={vendorId}
                  onChange={e => setVendorId(e.target.value)}
                  className="app-input"
                  required
                >
                  {vendors.length === 0 && <option value="">No vendors</option>}
                  {vendors.map(v => (
                    <option key={v.id} value={v.id}>{v.companyName}{v.name ? ` (${v.name})` : ''}</option>
                  ))}
                </select>
              </FormField>
              {selectedVendor && (
                <div className="mt-2 rounded-lg bg-slate-50/80 p-2.5 text-[11px] dark:bg-white/[0.03]">
                  <div className="font-semibold text-slate-700 dark:text-slate-200">{selectedVendor.companyName}</div>
                  {selectedVendor.email && <div className="text-slate-500 dark:text-slate-400">{selectedVendor.email}</div>}
                  {selectedVendor.phone && <div className="text-slate-500 dark:text-slate-400">{selectedVendor.phone}</div>}
                  {selectedVendor.address && <div className="mt-0.5 text-slate-500 dark:text-slate-400">{selectedVendor.address}</div>}
                </div>
              )}
            </FormSection>

            <FormSection title="Bill Details" icon={<Calendar className="h-3 w-3" />} aside>
              <div className="space-y-2.5">
                <FormField label="Bill Number">
                  <input
                    type="text"
                    value={billNumber}
                    onChange={e => setBillNumber(e.target.value)}
                    placeholder="Supplier's invoice #"
                    className="app-input"
                  />
                </FormField>
                <FormField label="Bill Date" required>
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
              <SummaryRow label="Total Payable" value={formatCurrency(total, currency)} emphasis tone="rose" />
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
          submitLabel="Save & Post Bill"
          submitIcon={<Save className="h-3.5 w-3.5" />}
          form="bill-form"
          disabled={!canSubmit}
          busy={submitting}
          tone="slate"
          left={<div className="text-[11px] text-slate-500 dark:text-slate-400">{selectedVendor?.companyName || 'No vendor selected'}</div>}
        />
      </form>
    </ModalShell>
  );
};