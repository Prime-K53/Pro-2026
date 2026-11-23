import React, { useEffect, useState } from 'react';
import { useAccounting } from '../../context/AccountingContext';
import { useAuth } from '../../context/AuthContext';
import { commercialApi } from '../../services/commercialApi';
import { AlertTriangle, Save, Users, X } from 'lucide-react';
import { ModalShell } from '../common/ui';

type CustomerType = 'School' | 'Corporate' | 'Individual' | 'Government' | 'Nonprofit';

const CURRENCIES = ['ZMW', 'USD', 'EUR', 'GBP', 'MWK', 'ZAR', 'NGN', 'KES'];
const TERMS = ['Due on Receipt', 'Net 15', 'Net 30', 'Net 60'] as const;

const today = () => new Date().toISOString().slice(0, 10);

export const NewCustomerModal: React.FC = () => {
  const { isNewCustomerOpen, setIsNewCustomerOpen, triggerShortcutNotice } = useAccounting();
  const { hasPermission, companies, activeCompany } = useAuth();
  const canWriteCustomers = hasPermission('customers:write');
  const companyCurrency =
    companies.find(c => c.id === activeCompany?.id)?.baseCurrency || 'ZMW';
  const currencyOptions = Array.from(new Set([companyCurrency, ...CURRENCIES]));

  const [companyName, setCompanyName] = useState('');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [billingAddress, setBillingAddress] = useState('');
  const [terms, setTerms] = useState<(typeof TERMS)[number]>('Net 30');
  const [notes, setNotes] = useState('');
  const [customerType, setCustomerType] = useState<CustomerType>('School');
  const [creditLimit, setCreditLimit] = useState<number>(0);
  const [isTaxExempt, setIsTaxExempt] = useState(false);
  const [openingBalance, setOpeningBalance] = useState<number>(0);
  const [openingBalanceDate, setOpeningBalanceDate] = useState(today());
  const [currency, setCurrency] = useState('ZMW');
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Verbal referral capture (optional).
  const [referredByCustomerId, setReferredByCustomerId] = useState<number | null>(null);
  const [referrerSearch, setReferrerSearch] = useState('');
  const [customerOptions, setCustomerOptions] = useState<any[]>([]);
  const [showReferrer, setShowReferrer] = useState(false);

  const reset = () => {
    setCompanyName('');
    setName('');
    setEmail('');
    setPhone('');
    setBillingAddress('');
    setTerms('Net 30');
    setNotes('');
    setCustomerType('School');
    setCreditLimit(0);
    setIsTaxExempt(false);
    setOpeningBalance(0);
    setOpeningBalanceDate(today());
    setCurrency(companyCurrency);
    setErrorMsg(null);
    setReferredByCustomerId(null);
    setReferrerSearch('');
    setShowReferrer(false);
  };

  useEffect(() => {
    if (isNewCustomerOpen) {
      reset();
      commercialApi
        .listCustomers()
        .then(list => setCustomerOptions(list))
        .catch(() => setCustomerOptions([]));
    }
    // Reset only when the modal transitions open; values are intentionally cleared.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isNewCustomerOpen]);

  const referrerMatches = customerOptions
    .filter(c => {
      if (!referrerSearch.trim()) return true;
      const hay = `${c.companyName || ''} ${c.name || ''} ${(c as any).customerCode || ''}`.toLowerCase();
      return hay.includes(referrerSearch.trim().toLowerCase());
    })
    .slice(0, 8);

  if (!isNewCustomerOpen) return null;

  const canSubmit = Boolean(companyName.trim() || name.trim());

  const close = () => setIsNewCustomerOpen(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!companyName.trim() && !name.trim()) return;
    if (!canWriteCustomers) {
      setErrorMsg('Your role cannot create customers (customers:write).');
      return;
    }

    setSubmitting(true);
    setErrorMsg(null);
    try {
      const created = await commercialApi.createCustomer({
        companyName: companyName.trim() || name.trim(),
        name: name.trim() || companyName.trim(),
        email,
        phone,
        billingAddress,
        terms,
        customerType: customerType.toLowerCase(),
        notes,
        creditLimit,
        isTaxExempt,
        openingBalance,
        openingBalanceDate,
        currencyCode: currency,
        referredByCustomerId,
      } as any);

      triggerShortcutNotice(`Customer ${created.companyName} saved to PostgreSQL`);
      setIsNewCustomerOpen(false);
      reset();
    } catch (err: any) {
      const message = err?.message || 'Failed to create the customer';
      setErrorMsg(message);
      triggerShortcutNotice(message, 'error');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <ModalShell
      open={isNewCustomerOpen}
      onClose={close}
      size="4xl"
      titleId="new-customer-title"
      className="!max-h-[min(73.6vh,568px)] !max-w-[728px]"
    >
      {/* Header */}
      <div className="flex shrink-0 items-center gap-3 bg-gradient-to-r from-brand-800 via-brand-600 to-brand-500 px-5 py-3 text-white">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-white/15 text-lg ring-1 ring-inset ring-white/20">
          <Users className="h-4 w-4" />
        </span>
        <div className="min-w-0">
          <div id="new-customer-title" className="text-[14.5px] font-semibold leading-tight">
            Add New Customer
          </div>
          <div className="text-[11.5px] text-white/80">
            Create a customer master record with billing, credit, and opening balance details
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
        id="new-customer-form"
        onSubmit={handleSubmit}
        className="flex min-h-0 flex-1 flex-col overflow-hidden md:flex-row"
      >
        {/* Sidebar */}
        <aside className="w-full shrink-0 space-y-5 overflow-auto border-b border-slate-200 bg-slate-50/80 p-5 dark:border-white/[0.06] dark:bg-white/[0.02] md:w-[260px] md:border-b-0 md:border-r">
          <div className="border-b border-slate-200 pb-4 dark:border-white/[0.06]">
            <p className="mb-2 text-[10.5px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
              Customer setup
            </p>

            <label className="mb-1 block text-[12px] text-slate-500 dark:text-slate-400">
              Customer type
            </label>
            <select
              value={customerType}
              onChange={e => setCustomerType(e.target.value as CustomerType)}
              className="app-input !py-2"
            >
              <option value="School">School</option>
              <option value="Corporate">Corporate</option>
              <option value="Individual">Individual</option>
              <option value="Government">Government</option>
              <option value="Nonprofit">Nonprofit</option>
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
                checked={isTaxExempt}
                onChange={e => setIsTaxExempt(e.target.checked)}
                className="mt-0.5 h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
              />
              <span className="text-[12px] leading-relaxed text-slate-600 dark:text-slate-300">
                Tax-exempt customer
              </span>
            </label>
            <p className="mt-1.5 text-[11px] leading-relaxed text-slate-400">
              Tax exemption is honored only while an active, unexpired reseller permit is on file.
            </p>
          </div>

          <div>
            <p className="mb-2 flex items-center gap-1.5 text-[10.5px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
              <AlertTriangle className="h-3 w-3" />
              Credit &amp; opening balance
            </p>

            <label className="mb-1 block text-[12px] text-slate-500 dark:text-slate-400">
              Credit limit
            </label>
            <input
              type="number"
              step="0.01"
              min="0"
              value={creditLimit || ''}
              onChange={e => setCreditLimit(Math.max(0, parseFloat(e.target.value) || 0))}
              placeholder="No limit"
              className="app-input app-input-mono !py-2"
            />

            <label className="mb-1 mt-2.5 block text-[12px] text-slate-500 dark:text-slate-400">
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
                  Posts an opening invoice and journal: Dr AR 1100 / Cr Opening Balance Equity 3900.
                </div>
              </>
            )}
          </div>
        </aside>

        {/* Main details */}
        <section className="min-h-0 min-w-0 flex-1 overflow-auto p-5">
          <p className="mb-2 text-[10.5px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
            Company details
          </p>

          <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-[12px] text-slate-500 dark:text-slate-400">
                Company / school name <span className="text-rose-500">*</span>
              </label>
              <input
                type="text"
                value={companyName}
                onChange={e => setCompanyName(e.target.value)}
                placeholder="e.g. Acme Aerospace Corporation"
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
                placeholder="e.g. Sarah Lindqvist"
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
                placeholder="billing@company.com"
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

          <div className="mt-3.5">
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

          <div className="mt-3.5">
            <label className="mb-1 block text-[12px] text-slate-500 dark:text-slate-400">
              Billing address
            </label>
            <textarea
              value={billingAddress}
              onChange={e => setBillingAddress(e.target.value)}
              rows={2}
              placeholder="Street, City, State, ZIP"
              className="app-input resize-none"
            />
          </div>

          <div className="mt-3.5">
            <label className="mb-1 block text-[12px] text-slate-500 dark:text-slate-400">
              Notes
            </label>
            <textarea
              value={notes}
              onChange={e => setNotes(e.target.value)}
              rows={3}
              placeholder="Customer specifics, tax exemption certificate info, delivery instructions…"
              className="app-input resize-none"
            />
          </div>

          <div className="mt-3.5">
            <label className="mb-1 block text-[12px] text-slate-500 dark:text-slate-400">
              Referred By <span className="text-slate-400">(Existing Customer)</span>
            </label>
            <div className="relative">
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={referrerSearch}
                  onChange={e => {
                    setReferrerSearch(e.target.value);
                    setShowReferrer(true);
                    if (referredByCustomerId != null) setReferredByCustomerId(null);
                  }}
                  onFocus={() => setShowReferrer(true)}
                  placeholder="Search by name or customer code (optional)"
                  className="app-input"
                />
                {referredByCustomerId != null && (
                  <button
                    type="button"
                    onClick={() => {
                      setReferredByCustomerId(null);
                      setReferrerSearch('');
                      setShowReferrer(false);
                    }}
                    className="btn btn-secondary !px-2 !py-2"
                    aria-label="Clear referrer"
                  >
                    <X className="h-4 w-4" />
                  </button>
                )}
              </div>
              {showReferrer && (
                <div className="absolute z-20 mt-1 max-h-56 w-full overflow-auto rounded-lg border border-slate-200 bg-white p-1 shadow-lg dark:border-white/10 dark:bg-slate-800">
                  {referrerMatches.length === 0 ? (
                    <div className="px-2 py-2 text-[12px] text-slate-400">No customers found</div>
                  ) : (
                    referrerMatches.map(c => (
                      <button
                        key={c.id}
                        type="button"
                        onClick={() => {
                          setReferredByCustomerId(c.id);
                          setReferrerSearch(c.companyName || c.name);
                          setShowReferrer(false);
                        }}
                        className={`flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-[12.5px] hover:bg-slate-100 dark:hover:bg-white/5 ${
                          referredByCustomerId === c.id ? 'bg-brand-50 dark:bg-brand-500/10' : ''
                        }`}
                      >
                        <span className="truncate text-slate-700 dark:text-slate-200">{c.companyName || c.name}</span>
                        <span className="ml-2 shrink-0 font-mono text-[10px] text-slate-400">
                          {(c as any).customerCode || `#${c.id}`}
                        </span>
                      </button>
                    ))
                  )}
                </div>
              )}
            </div>
            <p className="mt-1.5 text-[11px] leading-relaxed text-slate-400">
              Optional verbal referral. Recorded as acquisition method <span className="font-semibold">verbal</span> and
              attributed to the selected existing customer.
            </p>
          </div>

          <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50/70 p-4 dark:border-white/10 dark:bg-white/[0.03]">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="truncate text-[13px] font-semibold text-slate-800 dark:text-slate-100">
                  {companyName.trim() || name.trim() || 'New customer'}
                </div>
                <div className="mt-0.5 truncate text-[12px] text-slate-500 dark:text-slate-400">
                  {name.trim() || 'No primary contact'} · {customerType} · {terms}
                </div>
              </div>
              <span className="shrink-0 rounded-md bg-slate-200/70 px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wide text-slate-600 dark:bg-white/[0.08] dark:text-slate-300">
                CUST-###### auto
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
                <span className="text-slate-500 dark:text-slate-400">Credit limit</span>
                <span className="font-mono font-semibold text-slate-700 dark:text-slate-200">
                  {creditLimit > 0 ? creditLimit.toFixed(2) : 'No limit'}
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
                    isTaxExempt
                      ? 'text-emerald-600 dark:text-emerald-400'
                      : 'text-slate-700 dark:text-slate-200'
                  }`}
                >
                  {isTaxExempt ? 'Exempt (permit required)' : 'Taxable'}
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
          {canWriteCustomers
            ? 'Customer code is assigned automatically on save.'
            : 'Your role cannot create customers (customers:write).'}
        </span>
        <button type="button" onClick={close} className="btn btn-secondary">
          Cancel
        </button>
        <button
          type="submit"
          form="new-customer-form"
          disabled={!canSubmit || !canWriteCustomers || submitting}
          className="btn btn-primary !from-brand-600 !to-brand-700"
        >
          <Save className="h-3.5 w-3.5" />
          {submitting ? 'Saving…' : 'Save Customer'}
        </button>
      </footer>
    </ModalShell>
  );
};
