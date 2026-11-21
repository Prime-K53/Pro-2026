import React, { useEffect, useState } from 'react';
import { useAccounting } from '../../context/AccountingContext';
import { useAuth } from '../../context/AuthContext';
import { commercialApi } from '../../services/commercialApi';
import { AlertTriangle, Building2, Save, Users, X } from 'lucide-react';
import { ModalShell } from '../common/ui';

const CURRENCIES = ['ZMW', 'USD', 'EUR', 'GBP', 'MWK', 'ZAR', 'NGN', 'KES'];
const TERMS = ['Due on Receipt', 'Net 15', 'Net 30', 'Net 60'] as const;

const today = () => new Date().toISOString().slice(0, 10);

type VendorCategory = 'goods' | 'services' | 'logistics' | 'utilities' | 'contractor' | 'other';

export const NewVendorModal: React.FC = () => {
  const { isNewVendorOpen, setIsNewVendorOpen, accounts, triggerShortcutNotice } =
    useAccounting();
  const { hasPermission, companies, activeCompany } = useAuth();
  const canWriteVendors = hasPermission('vendors:write');
  const companyCurrency =
    companies.find(c => c.id === activeCompany?.id)?.baseCurrency || 'ZMW';
  const currencyOptions = Array.from(new Set([companyCurrency, ...CURRENCIES]));

  const expenseAccounts = accounts.filter(a =>
    ['Expense', 'CostOfGoodsSold', 'OtherExpense'].includes(a.type)
  );

  const [companyName, setCompanyName] = useState('');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [address, setAddress] = useState('');
  const [taxId, setTaxId] = useState('');
  const [terms, setTerms] = useState<(typeof TERMS)[number]>('Net 30');
  const [defaultExpenseAccountId, setDefaultExpenseAccountId] = useState(
    expenseAccounts[0]?.id || ''
  );
  const [is1099Eligible, setIs1099Eligible] = useState(false);
  const [notes, setNotes] = useState('');
  const [vendorCategory, setVendorCategory] = useState<VendorCategory>('goods');
  const [isPreferred, setIsPreferred] = useState(false);
  const [bankName, setBankName] = useState('');
  const [bankAccountName, setBankAccountName] = useState('');
  const [bankAccountNumber, setBankAccountNumber] = useState('');
  const [bankBranch, setBankBranch] = useState('');
  const [openingBalance, setOpeningBalance] = useState<number>(0);
  const [openingBalanceDate, setOpeningBalanceDate] = useState(today());
  const [currency, setCurrency] = useState(companyCurrency);
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const reset = () => {
    setCompanyName('');
    setName('');
    setEmail('');
    setPhone('');
    setAddress('');
    setTaxId('');
    setTerms('Net 30');
    setDefaultExpenseAccountId(expenseAccounts[0]?.id || '');
    setIs1099Eligible(false);
    setNotes('');
    setVendorCategory('goods');
    setIsPreferred(false);
    setBankName('');
    setBankAccountName('');
    setBankAccountNumber('');
    setBankBranch('');
    setOpeningBalance(0);
    setOpeningBalanceDate(today());
    setCurrency(companyCurrency);
    setErrorMsg(null);
  };

  useEffect(() => {
    if (isNewVendorOpen) reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isNewVendorOpen]);

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
        taxId,
        is1099Eligible,
        defaultExpenseAccountId:
          accountId && Number.isInteger(accountId) && accountId > 0 ? accountId : null,
        terms,
        notes,
        openingBalance,
        openingBalanceDate,
        currencyCode: currency,
        vendorCategory,
        isPreferred,
        bankName,
        bankAccountName,
        bankAccountNumber,
        bankBranch,
      });

      triggerShortcutNotice(`Vendor ${created.companyName} saved to PostgreSQL`);
      setIsNewVendorOpen(false);
      reset();
    } catch (err: any) {
      const message = err?.message || 'Failed to create the vendor';
      setErrorMsg(message);
      triggerShortcutNotice(message, 'error');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <ModalShell
      open={isNewVendorOpen}
      onClose={close}
      size="4xl"
      titleId="new-vendor-title"
      className="!max-h-[min(73.6vh,568px)] !max-w-[728px]"
    >
      {/* Header */}
      <div className="flex shrink-0 items-center gap-3 bg-gradient-to-r from-brand-800 via-brand-600 to-brand-500 px-5 py-3 text-white">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-white/15 text-lg ring-1 ring-inset ring-white/20">
          <Building2 className="h-4 w-4" />
        </span>
        <div className="min-w-0">
          <div id="new-vendor-title" className="text-[14.5px] font-semibold leading-tight">
            Add New Vendor
          </div>
          <div className="text-[11.5px] text-white/80">
            Create a vendor master record with remittance, tax, and opening balance details
          </div>
        </div>
        <button
          type="button"
          onClick={close}
          className="ml-auto rounded-lg p-1.5 text-white/80 transition-colors hover:bg-white/15 hover:text-white"
          aria-label="Close"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <form
        id="new-vendor-form"
        onSubmit={handleSubmit}
        className="flex min-h-0 flex-1 flex-col overflow-hidden md:flex-row"
      >
        {/* Sidebar */}
        <aside className="w-full shrink-0 space-y-5 overflow-auto border-b border-slate-200 bg-slate-50/80 p-5 dark:border-white/[0.06] dark:bg-white/[0.02] md:w-[260px] md:border-b-0 md:border-r">
          <div className="border-b border-slate-200 pb-4 dark:border-white/[0.06]">
            <p className="mb-2 text-[10.5px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
              Supplier setup
            </p>

            <label className="mb-1 block text-[12px] text-slate-500 dark:text-slate-400">
              Supplier category
            </label>
            <select
              value={vendorCategory}
              onChange={e => setVendorCategory(e.target.value as VendorCategory)}
              className="app-input !py-2"
            >
              <option value="goods">Goods</option>
              <option value="services">Services</option>
              <option value="logistics">Logistics</option>
              <option value="utilities">Utilities</option>
              <option value="contractor">Contractor</option>
              <option value="other">Other</option>
            </select>

            <label className="mb-1 mt-2.5 block text-[12px] text-slate-500 dark:text-slate-400">
              Currency
            </label>
            <select
              value={currency}
              onChange={e => setCurrency(e.target.value)}
              className="app-input !py-2"
            >
              {currencyOptions.map(c => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>

            <label className="mt-3 flex cursor-pointer items-start gap-2.5">
              <input
                type="checkbox"
                checked={isPreferred}
                onChange={e => setIsPreferred(e.target.checked)}
                className="mt-0.5 h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
              />
              <span className="text-[12px] leading-relaxed text-slate-600 dark:text-slate-300">
                Preferred supplier
              </span>
            </label>
          </div>

          <div className="border-b border-slate-200 pb-4 dark:border-white/[0.06]">
            <p className="mb-2 flex items-center gap-1.5 text-[10.5px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
              <AlertTriangle className="h-3 w-3" />
              Tax &amp; 1099
            </p>

            <label className="flex cursor-pointer items-start gap-2.5">
              <input
                type="checkbox"
                checked={is1099Eligible}
                onChange={e => setIs1099Eligible(e.target.checked)}
                className="mt-0.5 h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
              />
              <span className="text-[12px] leading-relaxed text-slate-600 dark:text-slate-300">
                Eligible for 1099 reporting
                <span className="mt-0.5 block text-[11px] text-slate-400 dark:text-slate-500">
                  Track this vendor for year-end 1099 tax forms.
                </span>
              </span>
            </label>
          </div>

          <div>
            <p className="mb-2 flex items-center gap-1.5 text-[10.5px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
              <AlertTriangle className="h-3 w-3" />
              Opening balance &amp; AP
            </p>

            <label className="mb-1 block text-[12px] text-slate-500 dark:text-slate-400">
              Opening balance
            </label>
            <input
              type="number"
              step="0.01"
              min="0"
              value={openingBalance || ''}
              onChange={e => setOpeningBalance(Math.max(0, parseFloat(e.target.value) || 0))}
              placeholder="0.00"
              className="app-input app-input-mono !py-2"
            />

            {openingBalance > 0 && (
              <>
                <label className="mb-1 mt-2.5 block text-[12px] text-slate-500 dark:text-slate-400">
                  Opening balance date
                </label>
                <input
                  type="date"
                  value={openingBalanceDate}
                  onChange={e => setOpeningBalanceDate(e.target.value)}
                  className="app-input !py-2"
                />
                <div className="mt-2 rounded-lg border border-amber-200 bg-amber-50/70 p-2.5 text-[11px] leading-relaxed text-amber-800 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-300">
                  Posts an opening bill and journal: Dr Opening Balance Equity 3900 / Cr AP 2000.
                </div>
              </>
            )}
          </div>
        </aside>

        {/* Main details */}
        <section className="min-h-0 min-w-0 flex-1 overflow-auto p-5">
          <p className="mb-2 text-[10.5px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
            Vendor details
          </p>

          <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-[12px] text-slate-500 dark:text-slate-400">
                Vendor / company name <span className="text-rose-500">*</span>
              </label>
              <input
                type="text"
                value={companyName}
                onChange={e => setCompanyName(e.target.value)}
                placeholder="e.g. Midwest Tool & Die Corp"
                className="app-input"
                required
              />
            </div>
            <div>
              <label className="mb-1 block text-[12px] text-slate-500 dark:text-slate-400">
                Primary contact
              </label>
              <input
                type="text"
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder="e.g. Dave Miller"
                className="app-input"
              />
            </div>
          </div>

          <div className="mt-3.5 grid grid-cols-1 gap-3.5 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-[12px] text-slate-500 dark:text-slate-400">
                Email
              </label>
              <input
                type="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                placeholder="invoices@vendor.com"
                className="app-input"
              />
            </div>
            <div>
              <label className="mb-1 block text-[12px] text-slate-500 dark:text-slate-400">
                Phone
              </label>
              <input
                type="text"
                value={phone}
                onChange={e => setPhone(e.target.value)}
                placeholder="(555) 000-0000"
                className="app-input"
              />
            </div>
          </div>

          <div className="mt-3.5 grid grid-cols-1 gap-3.5 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-[12px] text-slate-500 dark:text-slate-400">
                Tax ID / TPIN
              </label>
              <input
                type="text"
                value={taxId}
                onChange={e => setTaxId(e.target.value)}
                placeholder="XX-XXXXXXX"
                className="app-input font-mono"
              />
            </div>
            <div>
              <label className="mb-1 block text-[12px] text-slate-500 dark:text-slate-400">
                Payment terms
              </label>
              <select
                value={terms}
                onChange={e => setTerms(e.target.value as (typeof TERMS)[number])}
                className="app-input"
              >
                {TERMS.map(t => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="mt-3.5">
            <label className="mb-1 block text-[12px] text-slate-500 dark:text-slate-400">
              Remittance address
            </label>
            <textarea
              value={address}
              onChange={e => setAddress(e.target.value)}
              rows={2}
              placeholder="Street, City, State, ZIP"
              className="app-input resize-none"
            />
          </div>

          <div className="mt-3.5">
            <label className="mb-1 block text-[12px] text-slate-500 dark:text-slate-400">
              Default expense account
            </label>
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
          </div>

          <div className="mt-3.5">
            <label className="mb-1 block text-[12px] text-slate-500 dark:text-slate-400">
              Bank details
            </label>
            <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
              <input
                type="text"
                value={bankName}
                onChange={e => setBankName(e.target.value)}
                placeholder="Bank name"
                className="app-input"
              />
              <input
                type="text"
                value={bankAccountName}
                onChange={e => setBankAccountName(e.target.value)}
                placeholder="Account name"
                className="app-input"
              />
              <input
                type="text"
                value={bankAccountNumber}
                onChange={e => setBankAccountNumber(e.target.value)}
                placeholder="Account number"
                className="app-input font-mono"
              />
              <input
                type="text"
                value={bankBranch}
                onChange={e => setBankBranch(e.target.value)}
                placeholder="Branch"
                className="app-input"
              />
            </div>
          </div>

          <div className="mt-3.5">
            <label className="mb-1 block text-[12px] text-slate-500 dark:text-slate-400">
              Notes
            </label>
            <textarea
              value={notes}
              onChange={e => setNotes(e.target.value)}
              rows={3}
              placeholder="Payment instructions, terms, internal notes..."
              className="app-input resize-none"
            />
          </div>

          <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50/70 p-4 dark:border-white/10 dark:bg-white/[0.03]">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="truncate text-[13px] font-semibold text-slate-800 dark:text-slate-100">
                  {companyName.trim() || name.trim() || 'New vendor'}
                </div>
                <div className="mt-0.5 truncate text-[12px] text-slate-500 dark:text-slate-400">
                  {name.trim() || 'No primary contact'} · {vendorCategory} · {terms}
                </div>
              </div>
              <span className="shrink-0 rounded-md bg-slate-200/70 px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wide text-slate-600 dark:bg-white/[0.08] dark:text-slate-300">
                SUP-###### auto
              </span>
            </div>
            <div className="mt-3 grid grid-cols-2 gap-3 border-t border-slate-200 pt-3 text-[12px] dark:border-white/[0.06]">
              <div className="flex items-center justify-between">
                <span className="text-slate-500 dark:text-slate-400">Currency</span>
                <span className="font-mono font-semibold text-slate-700 dark:text-slate-200">
                  {currency}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-slate-500 dark:text-slate-400">Opening balance</span>
                <span className="font-mono font-semibold text-slate-700 dark:text-slate-200">
                  {openingBalance > 0 ? openingBalance.toFixed(2) : '—'}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-slate-500 dark:text-slate-400">Tax status</span>
                <span
                  className={`font-semibold ${
                    is1099Eligible
                      ? 'text-emerald-600 dark:text-emerald-400'
                      : 'text-slate-700 dark:text-slate-200'
                  }`}
                >
                  {is1099Eligible ? '1099 eligible' : 'Standard'}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-slate-500 dark:text-slate-400">Preferred</span>
                <span className="font-semibold text-slate-700 dark:text-slate-200">
                  {isPreferred ? 'Yes' : 'No'}
                </span>
              </div>
            </div>
          </div>
        </section>
      </form>

      {errorMsg && (
        <div className="border-t border-rose-200 bg-rose-50 px-5 py-2 text-[12px] text-rose-700 dark:border-rose-500/20 dark:bg-rose-500/10 dark:text-rose-300">
          {errorMsg}
        </div>
      )}

      {/* Footer */}
      <footer className="flex shrink-0 items-center gap-2.5 border-t border-slate-200 bg-white px-5 py-3 dark:border-white/[0.06] dark:bg-slate-900">
        <span className="mr-auto truncate text-[12px] text-slate-500 dark:text-slate-400">
          {canWriteVendors
            ? 'Vendor code is assigned automatically on save.'
            : 'Your role cannot create vendors (vendors:write).'}
        </span>
        <button type="button" onClick={close} className="btn btn-secondary">
          Cancel
        </button>
        <button
          type="submit"
          form="new-vendor-form"
          disabled={!canSubmit || !canWriteVendors || submitting}
          className="btn btn-primary !from-brand-600 !to-brand-700"
        >
          <Save className="h-3.5 w-3.5" />
          {submitting ? 'Saving…' : 'Save Vendor'}
        </button>
      </footer>
    </ModalShell>
  );
};
