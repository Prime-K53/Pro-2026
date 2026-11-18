import React, { useState } from 'react';
import { useAccounting } from '../../context/AccountingContext';
import { useAuth } from '../../context/AuthContext';
import { commercialApi } from '../../services/commercialApi';
import { AlertTriangle, Building2, Save } from 'lucide-react';
import {
  FormField,
  FormSection,
  InlineAlert,
  ModalBody,
  ModalFooter,
  ModalHeader,
  ModalShell,
} from '../common/ui';

const CURRENCIES = ['ZMW', 'USD', 'EUR', 'GBP', 'MWK', 'ZAR', 'NGN', 'KES'];

export const NewVendorModal: React.FC = () => {
  const { isNewVendorOpen, setIsNewVendorOpen, accounts, triggerShortcutNotice } = useAccounting();
  const { hasPermission } = useAuth();
  const canWriteVendors = hasPermission('vendors:write');

  const expenseAccounts = accounts.filter(a =>
    ['Expense', 'CostOfGoodsSold', 'OtherExpense'].includes(a.type)
  );

  const [companyName, setCompanyName] = useState('');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [address, setAddress] = useState('');
  const [einOrSsn, setEinOrSsn] = useState('');
  const [defaultExpenseAccountId, setDefaultExpenseAccountId] = useState(
    expenseAccounts[0]?.id || ''
  );
  const [terms, setTerms] = useState<'Due on Receipt' | 'Net 15' | 'Net 30' | 'Net 60'>('Net 30');
  const [is1099Eligible, setIs1099Eligible] = useState(false);
  const [notes, setNotes] = useState('');
  const [openingBalance, setOpeningBalance] = useState<number>(0);
  const [currency, setCurrency] = useState('ZMW');
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  if (!isNewVendorOpen) return null;

  const canSubmit = Boolean(companyName.trim() || name.trim());

  const close = () => setIsNewVendorOpen(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!companyName.trim() && !name.trim()) return;
    if (!canWriteVendors) {
      setErrorMsg('Your role cannot create vendors (vendors:write).');
      return;
    }

    setSubmitting(true);
    setErrorMsg(null);
    try {
      const accountId = defaultExpenseAccountId ? Number(defaultExpenseAccountId) : null;
      const created = await commercialApi.createVendor({
        companyName: companyName.trim() || name.trim(),
        name: name.trim() || companyName.trim(),
        email,
        phone,
        address,
        taxId: einOrSsn || '',
        is1099Eligible,
        defaultExpenseAccountId:
          accountId && Number.isInteger(accountId) && accountId > 0 ? accountId : null,
        terms,
        notes,
        openingBalance,
        currencyCode: currency,
      });

      triggerShortcutNotice(`Vendor ${created.companyName} saved to PostgreSQL`);
      setIsNewVendorOpen(false);
      setCompanyName('');
      setName('');
      setEmail('');
      setPhone('');
      setAddress('');
      setEinOrSsn('');
      setIs1099Eligible(false);
      setNotes('');
      setOpeningBalance(0);
      setCurrency('ZMW');
    } catch (err: any) {
      const message = err?.message || 'Failed to create the vendor';
      setErrorMsg(message);
      triggerShortcutNotice(message, 'error');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <ModalShell open={isNewVendorOpen} onClose={close} size="2xl" titleId="new-vendor-title">
      <ModalHeader
        title="Add New Vendor"
        subtitle="Create a vendor record with contact, payment and tax details."
        icon={<Building2 className="h-4 w-4" />}
        tone="slate"
        onClose={close}
      />

      <form id="new-vendor-form" onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col">
        <ModalBody columns={2}>
          {errorMsg && (
            <div className="lg:col-span-2">
              <InlineAlert tone="error">{errorMsg}</InlineAlert>
            </div>
          )}

          <FormSection title="Vendor Details">
            <FormField label="Vendor / Company Name" required>
              <input
                type="text"
                value={companyName}
                onChange={e => setCompanyName(e.target.value)}
                placeholder="e.g. Midwest Tool & Die Corp"
                className="app-input"
                required
              />
            </FormField>

            <div className="grid grid-cols-2 gap-4">
              <FormField label="Contact Person">
                <input
                  type="text"
                  value={name}
                  onChange={e => setName(e.target.value)}
                  placeholder="e.g. Dave Miller"
                  className="app-input"
                />
              </FormField>
              <FormField label="Tax ID / EIN">
                <input
                  type="text"
                  value={einOrSsn}
                  onChange={e => setEinOrSsn(e.target.value)}
                  placeholder="XX-XXXXXXX"
                  className="app-input font-mono"
                />
              </FormField>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <FormField label="Email">
                <input
                  type="email"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  placeholder="invoices@vendor.com"
                  className="app-input"
                />
              </FormField>
              <FormField label="Phone">
                <input
                  type="text"
                  value={phone}
                  onChange={e => setPhone(e.target.value)}
                  placeholder="(555) 000-0000"
                  className="app-input"
                />
              </FormField>
            </div>

            <FormField label="Remittance Address">
              <textarea
                value={address}
                onChange={e => setAddress(e.target.value)}
                rows={2}
                placeholder="Street, City, State, ZIP"
                className="app-input"
              />
            </FormField>

            <FormField label="Notes">
              <textarea
                value={notes}
                onChange={e => setNotes(e.target.value)}
                rows={2}
                placeholder="Payment instructions, terms, internal notes..."
                className="app-input"
              />
            </FormField>
          </FormSection>

          <div className="space-y-4">
            <FormSection aside title="Tax & 1099" icon={<AlertTriangle className="h-3.5 w-3.5" />}>
              <label className="flex cursor-pointer items-start gap-2.5">
                <input
                  type="checkbox"
                  checked={is1099Eligible}
                  onChange={e => setIs1099Eligible(e.target.checked)}
                  className="mt-0.5 h-4 w-4 rounded border-slate-300 text-slate-700 focus:ring-slate-500"
                />
                <span className="text-[12px] leading-relaxed text-slate-600 dark:text-slate-300">
                  Eligible for 1099 reporting
                  <span className="mt-0.5 block text-[11px] text-slate-400 dark:text-slate-500">
                    Track this vendor for year-end 1099 tax forms.
                  </span>
                </span>
              </label>
            </FormSection>

            <FormSection aside title="Payment & Accounts">
              <FormField label="Payment Terms">
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
              <FormField label="Default Expense Account">
                <select
                  value={defaultExpenseAccountId}
                  onChange={e => setDefaultExpenseAccountId(e.target.value)}
                  className="app-input"
                >
                  {expenseAccounts.map(acc => (
                    <option key={acc.id} value={acc.id}>
                      {acc.code} - {acc.name}
                    </option>
                  ))}
                </select>
              </FormField>
            </FormSection>

            <FormSection aside title="Opening Balance & Currency">
              <FormField label="Opening Balance">
                <input
                  type="number"
                  step="0.01"
                  value={openingBalance}
                  onChange={e => setOpeningBalance(parseFloat(e.target.value) || 0)}
                  className="app-input"
                />
              </FormField>
              <FormField label="Currency">
                <select
                  value={currency}
                  onChange={e => setCurrency(e.target.value)}
                  className="app-input"
                >
                  {CURRENCIES.map(c => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </FormField>
            </FormSection>
          </div>
        </ModalBody>
      </form>

      <ModalFooter
        onCancel={close}
        form="new-vendor-form"
        tone="slate"
        submitLabel="Save Vendor"
        submitIcon={<Save className="h-3.5 w-3.5" />}
        disabled={!canSubmit || !canWriteVendors}
        busy={submitting}
      />
    </ModalShell>
  );
};