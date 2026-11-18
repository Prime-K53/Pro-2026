import React, { useState } from 'react';
import { useAccounting } from '../../context/AccountingContext';
import { useAuth } from '../../context/AuthContext';
import { commercialApi } from '../../services/commercialApi';
import { AlertTriangle, Save, Users } from 'lucide-react';
import {
  FormField,
  FormSection,
  InlineAlert,
  ModalBody,
  ModalFooter,
  ModalHeader,
  ModalShell,
} from '../common/ui';

type CustomerType = 'School' | 'Corporate' | 'Individual' | 'Government' | 'Nonprofit';

const CURRENCIES = ['ZMW', 'USD', 'EUR', 'GBP', 'MWK', 'ZAR', 'NGN', 'KES'];

export const NewCustomerModal: React.FC = () => {
  const { isNewCustomerOpen, setIsNewCustomerOpen, triggerShortcutNotice } = useAccounting();
  const { hasPermission } = useAuth();
  const canWriteCustomers = hasPermission('customers:write');

  const [companyName, setCompanyName] = useState('');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [billingAddress, setBillingAddress] = useState('');
  const [terms, setTerms] = useState<'Due on Receipt' | 'Net 15' | 'Net 30' | 'Net 60'>('Net 30');
  const [notes, setNotes] = useState('');
  const [customerType, setCustomerType] = useState<CustomerType>('School');
  const [creditLimit, setCreditLimit] = useState<number>(0);
  const [isTaxExempt, setIsTaxExempt] = useState(false);
  const [openingBalance, setOpeningBalance] = useState<number>(0);
  const [currency, setCurrency] = useState('ZMW');
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

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
        address: billingAddress,
        terms,
        customerType,
        creditLimit,
        isTaxExempt,
        openingBalance,
        currencyCode: currency,
      } as any);

      triggerShortcutNotice(`Customer ${created.companyName} saved to PostgreSQL`);
      setIsNewCustomerOpen(false);
      setCompanyName('');
      setName('');
      setEmail('');
      setPhone('');
      setBillingAddress('');
      setNotes('');
      setCustomerType('School');
      setCreditLimit(0);
      setIsTaxExempt(false);
      setOpeningBalance(0);
      setCurrency('ZMW');
    } catch (err: any) {
      const message = err?.message || 'Failed to create the customer';
      setErrorMsg(message);
      triggerShortcutNotice(message, 'error');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <ModalShell open={isNewCustomerOpen} onClose={close} size="2xl" titleId="new-customer-title">
      <ModalHeader
        title="Add New Customer"
        subtitle="Create a customer record with billing and credit details."
        icon={<Users className="h-4 w-4" />}
        tone="brand"
        onClose={close}
      />

      <form id="new-customer-form" onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col">
        <ModalBody columns={2}>
          {errorMsg && (
            <div className="lg:col-span-2">
              <InlineAlert tone="error">{errorMsg}</InlineAlert>
            </div>
          )}

          <FormSection title="Company Details">
            <FormField label="Company Name" required>
              <input
                type="text"
                value={companyName}
                onChange={e => setCompanyName(e.target.value)}
                placeholder="e.g. Acme Aerospace Corporation"
                className="app-input"
                required
              />
            </FormField>

            <div className="grid grid-cols-2 gap-4">
              <FormField label="Primary Contact">
                <input
                  type="text"
                  value={name}
                  onChange={e => setName(e.target.value)}
                  placeholder="e.g. Sarah Lindqvist"
                  className="app-input"
                />
              </FormField>
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
            </div>

            <div className="grid grid-cols-2 gap-4">
              <FormField label="Email">
                <input
                  type="email"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  placeholder="billing@company.com"
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

            <FormField label="Billing Address">
              <textarea
                value={billingAddress}
                onChange={e => setBillingAddress(e.target.value)}
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
                placeholder="Customer specifics, tax exemption certificate info, etc."
                className="app-input"
              />
            </FormField>
          </FormSection>

          <div className="space-y-4">
            <FormSection aside title="Customer Type">
              <select
                value={customerType}
                onChange={e => setCustomerType(e.target.value as CustomerType)}
                className="app-input"
              >
                <option value="School">School</option>
                <option value="Corporate">Corporate</option>
                <option value="Individual">Individual</option>
                <option value="Government">Government</option>
                <option value="Nonprofit">Nonprofit</option>
              </select>
            </FormSection>

            <FormSection aside title="Credit & Opening Balance" icon={<AlertTriangle className="h-3.5 w-3.5" />}>
              <FormField label="Credit Limit">
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  value={creditLimit}
                  onChange={e => setCreditLimit(parseFloat(e.target.value) || 0)}
                  className="app-input"
                />
              </FormField>
              <FormField label="Opening Balance">
                <input
                  type="number"
                  step="0.01"
                  value={openingBalance}
                  onChange={e => setOpeningBalance(parseFloat(e.target.value) || 0)}
                  className="app-input"
                />
              </FormField>
            </FormSection>

            <FormSection aside title="Tax & Currency">
              <label className="flex cursor-pointer items-start gap-2.5">
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
        form="new-customer-form"
        tone="brand"
        submitLabel="Save Customer"
        submitIcon={<Save className="h-3.5 w-3.5" />}
        disabled={!canSubmit || !canWriteCustomers}
        busy={submitting}
      />
    </ModalShell>
  );
};